package operations

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"io/fs"
	"os"
	"os/exec"
	"os/user"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"testing"
)

func fixture(t *testing.T) Guest {
	t.Helper()
	u, err := user.Current()
	if err != nil {
		t.Fatal(err)
	}
	work := t.TempDir()
	return Guest{Root: t.TempDir(), Work: work, User: u.Username, Home: work, RecordID: "record-one", Generation: 3,
		commandGroup: func() (*os.File, func() error, error) { return nil, func() error { return nil }, nil }}
}

func hash(data string) string { sum := sha256.Sum256([]byte(data)); return hex.EncodeToString(sum[:]) }

func TestBlobUploadChecksBytesAndNeverReplacesImmutableInput(t *testing.T) {
	g := fixture(t)
	input := "private local Git bundle bytes"
	if err := g.prepare(); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(g.Root, "blobs", ".upload-2147483647-gone-partial"), []byte("interrupted upload"), 0o600); err != nil {
		t.Fatal(err)
	}
	blob, err := g.PutBlob(hash(input), strings.NewReader(input))
	if err != nil {
		t.Fatal(err)
	}
	if blob.Size != int64(len(input)) || blob.SHA256 != hash(input) {
		t.Fatalf("blob = %+v", blob)
	}
	info, err := os.Stat(blob.Path)
	if err != nil || info.Mode().Perm() != 0o444 {
		t.Fatalf("blob mode: %v %v", info, err)
	}
	if _, err := g.PutBlob(hash(input), strings.NewReader("changed")); err == nil {
		t.Fatal("accepted bytes with the wrong digest")
	}
	if got, err := os.ReadFile(blob.Path); err != nil || string(got) != input {
		t.Fatalf("immutable input changed: %q %v", got, err)
	}
	if _, err := g.PutBlob(hash(input), strings.NewReader(input)); err != nil {
		t.Fatal(err)
	}
	entries, err := os.ReadDir(filepath.Dir(blob.Path))
	if err != nil || len(entries) != 1 {
		t.Fatalf("partial upload survived: %v %v", entries, err)
	}
}

func TestCaptureIsFrozenAndBoundToItsRequest(t *testing.T) {
	g := fixture(t)
	path := filepath.Join(g.Work, "result.bundle")
	if err := os.WriteFile(path, []byte("first result"), 0o600); err != nil {
		t.Fatal(err)
	}
	request := Capture{Path: "result.bundle", MaxBytes: 64}
	blob, err := g.Capture("result", request)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte("later edits"), 0o600); err != nil {
		t.Fatal(err)
	}
	again, err := g.Capture("result", request)
	if err != nil || again != blob {
		t.Fatalf("capture replay = %+v %v", again, err)
	}
	var got bytes.Buffer
	if err := g.ReadCapture("result", &got); err != nil || got.String() != "first result" {
		t.Fatalf("frozen capture = %q %v", got.String(), err)
	}
	if _, err := g.Capture("result", Capture{Path: "other", MaxBytes: 64}); err == nil {
		t.Fatal("capture ID accepted a different source")
	}
	if _, err := g.Capture("small", Capture{Path: "result.bundle", MaxBytes: 1}); err == nil {
		t.Fatal("capture exceeded its byte limit")
	}
	if _, err := os.Stat(filepath.Join(g.namespace(), "captures", "small")); !errors.Is(err, fs.ErrNotExist) {
		t.Fatalf("oversized capture was committed: %v", err)
	}
}

func TestCaptureRejectsWorkspaceEscapeAndNonRegularFiles(t *testing.T) {
	g := fixture(t)
	outside := filepath.Join(t.TempDir(), "secret")
	if err := os.WriteFile(outside, []byte("private"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, filepath.Join(g.Work, "escape")); err != nil {
		t.Fatal(err)
	}
	if err := syscall.Mkfifo(filepath.Join(g.Work, "fifo"), 0o600); err != nil {
		t.Fatal(err)
	}
	for _, path := range []string{"../secret", "/etc/shadow", "escape", ".", "fifo"} {
		if _, err := g.Capture("escape", Capture{Path: path, MaxBytes: 64}); err == nil {
			t.Fatalf("accepted capture %q", path)
		}
	}
}

func command(t *testing.T, script string) Command {
	t.Helper()
	sh, err := exec.LookPath("sh")
	if err != nil {
		t.Fatal(err)
	}
	return Command{Argv: []string{sh, "-c", script}, Cwd: ".", TimeoutMS: 5000, MaxOutputBytes: 1024, MachineRevision: strings.Repeat("a", 64)}
}

func TestDetachedCommandReceiptPreventsReplayAndRetainsExactIdentity(t *testing.T) {
	g := fixture(t)
	launches := 0
	g.Launch = func(id string) error { launches++; return g.RunJob(id) }
	request := command(t, "printf once >> result; printf stdout; printf stderr >&2")
	job, err := g.StartJob("verify", request)
	if err != nil {
		t.Fatal(err)
	}
	if job.Status != Succeeded || job.ExitCode == nil || *job.ExitCode != 0 || job.Stdout != "stdout" || job.Stderr != "stderr" || job.RecordID != g.RecordID || job.Generation != g.Generation || job.MachineRevision != request.MachineRevision {
		t.Fatalf("job = %+v", job)
	}
	if _, err := g.StartJob("verify", request); err != nil {
		t.Fatal(err)
	}
	request.Argv = append(request.Argv, "changed")
	if _, err := g.StartJob("verify", request); err == nil {
		t.Fatal("job ID accepted a different command")
	}
	if launches != 1 {
		t.Fatalf("command dispatched %d times", launches)
	}
	if got, err := os.ReadFile(filepath.Join(g.Work, "result")); err != nil || string(got) != "once" {
		t.Fatalf("command repeated: %q %v", got, err)
	}
}

func TestCommandTimeoutAndSharedOutputBudgetAreTerminal(t *testing.T) {
	sleep, err := exec.LookPath("sleep")
	if err != nil {
		t.Fatal(err)
	}
	for _, test := range []struct {
		name, script    string
		timeout, output int64
		status          Status
	}{
		{"timeout", strconv.Quote(sleep) + " 10", 50, 1024, TimedOut},
		{"output", "printf 01234567890123456789; printf abcdefghijklmnopqrst >&2", 5000, 24, Failed},
	} {
		t.Run(test.name, func(t *testing.T) {
			g := fixture(t)
			g.Launch = func(id string) error { return g.RunJob(id) }
			request := command(t, test.script)
			request.TimeoutMS = test.timeout
			request.MaxOutputBytes = test.output
			job, err := g.StartJob(test.name, request)
			if err != nil {
				t.Fatal(err)
			}
			if job.Status != test.status || int64(len(job.Stdout)+len(job.Stderr)) > test.output {
				t.Fatalf("bounded job = %+v", job)
			}
		})
	}
}

func TestTerminalReceiptFollowsCommandScopeCleanup(t *testing.T) {
	g := fixture(t)
	cleaned := false
	g.commandGroup = func() (*os.File, func() error, error) {
		return nil, func() error {
			if cleaned {
				return nil
			}
			state, err := readJSON[jobRecord](filepath.Join(g.jobPath("cleanup"), "state.json"))
			if err != nil {
				t.Fatal(err)
			}
			if state.Status != Running {
				t.Fatalf("terminal receipt preceded process cleanup: %+v", state)
			}
			cleaned = true
			return nil
		}, nil
	}
	g.Launch = func(id string) error { return g.RunJob(id) }
	job, err := g.StartJob("cleanup", command(t, "printf done"))
	if err != nil || !cleaned || job.Status != Succeeded {
		t.Fatalf("command cleanup was not acknowledged: %+v, cleaned=%v, %v", job, cleaned, err)
	}
}

func TestLostRunnerHasAnExplicitUnknownOutcomeAndNeverReruns(t *testing.T) {
	g := fixture(t)
	launches := 0
	g.Launch = func(string) error { launches++; return nil }
	request := command(t, "printf should-not-run")
	if _, err := g.StartJob("lost", request); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(g.jobPath("lost"), "state.json")
	record, err := readJSON[jobRecord](path)
	if err != nil {
		t.Fatal(err)
	}
	record.PID = 2147483647
	record.Process = "missing"
	if err := writeJSON(path, record); err != nil {
		t.Fatal(err)
	}
	job, err := g.Job("lost")
	if err != nil {
		t.Fatal(err)
	}
	if job.Status != Failed || !strings.Contains(job.Error, "unknown") {
		t.Fatalf("lost runner = %+v", job)
	}
	if _, err := g.StartJob("lost", request); err != nil {
		t.Fatal(err)
	}
	if launches != 1 {
		t.Fatalf("lost command dispatched %d times", launches)
	}
}
