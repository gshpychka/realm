package operations

import (
	"context"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/gshpychka/realm/packages/bay/internal/fault"
	"github.com/gshpychka/realm/packages/bay/internal/processes"
)

type jobRecord struct {
	Job
	Digest  string `json:"requestDigest"`
	PID     int    `json:"runnerPid,omitempty"`
	Process string `json:"runnerProcess,omitempty"`
}

// StartJob commits the request before handing it to systemd. Replaying an ID only observes that request; it never
// dispatches it again, including when a crash interrupted the gap between commit and dispatch.
func (g Guest) StartJob(id string, request Command) (Job, error) {
	if !ValidID(id) {
		return Job{}, fmt.Errorf("%w: invalid job ID", fault.Invalid)
	}
	if err := request.Validate(); err != nil {
		return Job{}, err
	}
	if err := g.prepare(); err != nil {
		return Job{}, err
	}
	if request.InputDigest != "" {
		if _, err := g.Blob(request.InputDigest); err != nil {
			return Job{}, err
		}
	}
	dest := g.jobPath(id)
	if existing, err := readJSON[jobRecord](filepath.Join(dest, "state.json")); err == nil {
		if existing.Digest != Digest(request) {
			return Job{}, fmt.Errorf("%w: job ID has another command", fault.Conflict)
		}
		return g.Job(id)
	} else if !errors.Is(err, fs.ErrNotExist) {
		return Job{}, err
	}
	staging, err := os.MkdirTemp(filepath.Dir(dest), stagingPrefix(".job-"))
	if err != nil {
		return Job{}, err
	}
	defer os.RemoveAll(staging)
	record := jobRecord{Job: Job{ID: id, RecordID: g.RecordID, Generation: g.Generation, Command: request, Status: Running, Created: time.Now().UTC()}, Digest: Digest(request)}
	if err := writeJSON(filepath.Join(staging, "state.json"), record); err != nil {
		return Job{}, err
	}
	if err := os.Rename(staging, dest); err != nil {
		if errors.Is(err, fs.ErrExist) {
			return g.StartJob(id, request)
		}
		return Job{}, err
	}
	if err := syncDirectory(filepath.Dir(dest)); err != nil {
		return Job{}, err
	}
	if g.Launch == nil {
		return Job{}, errors.New("no detached command runner is configured")
	}
	if err := g.Launch(id); err != nil {
		// The dispatch outcome may be unknown. Keep the durable receipt and never repeat a command automatically.
		return Job{}, fmt.Errorf("command dispatch outcome is unknown; inspect job %s: %w", id, err)
	}
	return g.Job(id)
}

func (g Guest) Job(id string) (Job, error) {
	if !ValidID(id) {
		return Job{}, fmt.Errorf("%w: invalid job ID", fault.Invalid)
	}
	unlock, err := g.lockJob(id)
	if err != nil {
		return Job{}, err
	}
	defer unlock()
	record, err := readJSON[jobRecord](filepath.Join(g.jobPath(id), "state.json"))
	if err != nil {
		return Job{}, err
	}
	if record.Status == Running {
		current := processIdentity(record.PID)
		lost := record.PID > 0 && (record.Process == "" || current == "" || current != record.Process)
		// A committed request whose detached runner never arrived is also uncertain, never safe to replay.
		if lost || record.PID == 0 && time.Since(record.Created) > 10*time.Second {
			record.Status = Failed
			record.Error = "command was interrupted before its exit was recorded; outcome is unknown"
			finished := time.Now().UTC()
			record.Finished = &finished
			if err := writeJSON(filepath.Join(g.jobPath(id), "state.json"), record); err != nil {
				return Job{}, err
			}
		}
	}
	stdout, err := readOutput(filepath.Join(g.jobPath(id), "stdout"), record.MaxOutputBytes)
	if err != nil {
		return Job{}, err
	}
	stderr, err := readOutput(filepath.Join(g.jobPath(id), "stderr"), record.MaxOutputBytes)
	if err != nil {
		return Job{}, err
	}
	record.Stdout, record.Stderr = stdout, stderr
	return record.Job, nil
}

func (g Guest) lockJob(id string) (func(), error) {
	lock, err := os.OpenFile(filepath.Join(g.jobPath(id), "lock"), os.O_CREATE|os.O_RDWR, 0o600)
	if errors.Is(err, fs.ErrNotExist) {
		return nil, fmt.Errorf("%w: no job %s", fault.NotFound, id)
	}
	if err != nil {
		return nil, err
	}
	if err := syscall.Flock(int(lock.Fd()), syscall.LOCK_EX); err != nil {
		lock.Close()
		return nil, err
	}
	return func() { syscall.Flock(int(lock.Fd()), syscall.LOCK_UN); lock.Close() }, nil
}

// RunJob is the root-owned receipt/log writer. Only its child runs the requested command, as the session user.
func (g Guest) RunJob(id string) error {
	if !ValidID(id) {
		return fmt.Errorf("%w: invalid job ID", fault.Invalid)
	}
	unlock, err := g.lockJob(id)
	if err != nil {
		return err
	}
	record, err := readJSON[jobRecord](filepath.Join(g.jobPath(id), "state.json"))
	if err != nil {
		unlock()
		return err
	}
	if record.Status != Running || record.PID != 0 {
		unlock()
		return nil
	}
	started := time.Now().UTC()
	record.Started = &started
	record.PID = os.Getpid()
	record.Process = processIdentity(record.PID)
	if err := writeJSON(filepath.Join(g.jobPath(id), "state.json"), record); err != nil {
		unlock()
		return err
	}
	unlock()

	stdout, err := os.OpenFile(filepath.Join(g.jobPath(id), "stdout"), os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		return g.finishJob(id, record, Failed, nil, err.Error())
	}
	defer stdout.Close()
	stderr, err := os.OpenFile(filepath.Join(g.jobPath(id), "stderr"), os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		return g.finishJob(id, record, Failed, nil, err.Error())
	}
	defer stderr.Close()
	ctx, cancel := context.WithTimeout(context.Background(), time.Duration(record.TimeoutMS)*time.Millisecond)
	defer cancel()
	budget := &outputBudget{remaining: record.MaxOutputBytes, cancel: cancel}
	command := exec.CommandContext(ctx, record.Argv[0], record.Argv[1:]...)
	command.Dir = filepath.Join(g.Work, record.Cwd)
	command.Env = []string{"HOME=" + g.Home, "USER=" + g.User, "LOGNAME=" + g.User,
		"PATH=/run/wrappers/bin:/etc/profiles/per-user/" + g.User + "/bin:/run/current-system/sw/bin", "LANG=C.UTF-8"}
	executable, err := processes.Executable(record.Argv[0], command.Env, command.Dir)
	if err != nil {
		return g.finishJob(id, record, Failed, nil, err.Error())
	}
	command.Path, command.Err = executable, nil
	credential, err := processes.Credentials(g.User)
	if err != nil {
		return g.finishJob(id, record, Failed, nil, err.Error())
	}
	newGroup := g.commandGroup
	if newGroup == nil {
		newGroup = processes.NewGroup
	}
	group, cleanup, err := newGroup()
	if err != nil {
		return g.finishJob(id, record, Failed, nil, err.Error())
	}
	defer cleanup()
	command.SysProcAttr = &syscall.SysProcAttr{Setpgid: true, Credential: credential}
	if group != nil {
		command.SysProcAttr.UseCgroupFD = true
		command.SysProcAttr.CgroupFD = int(group.Fd())
	}
	command.Stdout = &boundedOutput{budget: budget, file: stdout}
	command.Stderr = &boundedOutput{budget: budget, file: stderr}
	command.Cancel = func() error {
		if command.Process == nil {
			return os.ErrProcessDone
		}
		return processes.KillGroup(group, command.Process.Pid)
	}
	command.WaitDelay = 5 * time.Second
	err = command.Run()
	if command.Process != nil {
		processes.KillGroup(group, command.Process.Pid)
	}
	// The terminal receipt cannot precede descendants that changed process
	// groups or sessions. The root-owned subgroup cannot be escaped by dev.
	if cleanupErr := cleanup(); cleanupErr != nil {
		return g.finishJob(id, record, Failed, nil, cleanupErr.Error())
	}
	// The durable terminal receipt follows the durable logs, never the other way around.
	if syncErr := stdout.Sync(); syncErr != nil {
		return syncErr
	}
	if syncErr := stderr.Sync(); syncErr != nil {
		return syncErr
	}
	status := Succeeded
	var code *int
	if command.ProcessState != nil {
		exit := command.ProcessState.ExitCode()
		code = &exit
	}
	reason := ""
	if errors.Is(ctx.Err(), context.DeadlineExceeded) {
		status = TimedOut
		reason = "command exceeded its timeout"
	} else if budget.exceeded {
		status = Failed
		reason = "command exceeded its output byte limit"
	} else if err != nil {
		status = Failed
		reason = err.Error()
	}
	return g.finishJob(id, record, status, code, reason)
}

func (g Guest) finishJob(id string, record jobRecord, status Status, code *int, reason string) error {
	unlock, err := g.lockJob(id)
	if err != nil {
		return err
	}
	defer unlock()
	record.Status = status
	record.ExitCode = code
	record.Error = reason
	finished := time.Now().UTC()
	record.Finished = &finished
	return writeJSON(filepath.Join(g.jobPath(id), "state.json"), record)
}

type outputBudget struct {
	mu        sync.Mutex
	remaining int64
	exceeded  bool
	cancel    context.CancelFunc
}
type boundedOutput struct {
	budget *outputBudget
	file   *os.File
}

func (w *boundedOutput) Write(p []byte) (int, error) {
	w.budget.mu.Lock()
	defer w.budget.mu.Unlock()
	keep := min(int64(len(p)), w.budget.remaining)
	n, err := w.file.Write(p[:keep])
	w.budget.remaining -= int64(n)
	if err != nil {
		return n, err
	}
	if int64(len(p)) > keep {
		w.budget.exceeded = true
		w.budget.cancel()
		return n, errors.New("command output byte limit exceeded")
	}
	return n, nil
}

func readOutput(path string, limit int64) (string, error) {
	f, err := os.Open(path)
	if errors.Is(err, fs.ErrNotExist) {
		return "", nil
	}
	if err != nil {
		return "", err
	}
	defer f.Close()
	data, err := io.ReadAll(io.LimitReader(f, limit+1))
	if err != nil {
		return "", err
	}
	if int64(len(data)) > limit {
		return "", errors.New("command log exceeded its recorded limit")
	}
	return string(data), nil
}

func processIdentity(pid int) string {
	data, err := os.ReadFile(filepath.Join("/proc", strconv.Itoa(pid), "stat"))
	if err != nil {
		return ""
	}
	fields := strings.Fields(string(data)[strings.LastIndexByte(string(data), ')')+1:])
	if len(fields) < 20 {
		return ""
	}
	return fields[19]
}
