package environment

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/gshpychka/realm/packages/bay/internal/processes"
)

func (c *connection) start(r request) {
	c.mu.Lock()
	if c.closed || len(c.commands) >= 8 || c.commands[r.ID] != nil {
		c.mu.Unlock()
		c.send(response{ID: r.ID, Error: &failure{"spawn_error", "environment command limit reached or duplicate request ID"}})
		return
	}
	ctx, cancel := context.WithCancel(context.Background())
	c.commands[r.ID] = cancel
	c.wg.Add(1)
	c.mu.Unlock()
	go func() {
		defer c.wg.Done()
		defer cancel()
		defer func() { c.mu.Lock(); delete(c.commands, r.ID); c.mu.Unlock() }()
		c.run(ctx, r)
	}()
}
func (c *connection) run(ctx context.Context, r request) {
	var argv []string
	var shell string
	if err := json.Unmarshal(r.Command, &shell); err == nil {
		argv = []string{"/run/current-system/sw/bin/bash", "-c", shell}
	} else if err := json.Unmarshal(r.Command, &argv); err != nil || len(argv) == 0 {
		c.send(response{ID: r.ID, Error: &failure{"spawn_error", "invalid command"}})
		return
	}
	if r.Timeout < 0 || r.Timeout > 2_147_483_647 {
		c.send(response{ID: r.ID, Error: &failure{"spawn_error", "invalid command timeout"}})
		return
	}
	if r.Timeout > 0 {
		var cancel context.CancelFunc
		ctx, cancel = context.WithTimeout(ctx, time.Duration(r.Timeout)*time.Millisecond)
		defer cancel()
	}
	command := exec.CommandContext(ctx, argv[0], argv[1:]...)
	command.Dir = r.Path
	if r.InheritEnv == nil || *r.InheritEnv {
		command.Env = os.Environ()
		if c.environment != nil {
			command.Env = append([]string{}, c.environment...)
		}
	} else {
		command.Env = []string{}
	}
	for key, value := range r.Env {
		if key == "" || strings.ContainsAny(key, "=\x00") || strings.ContainsRune(value, 0) {
			c.send(response{ID: r.ID, Error: &failure{"spawn_error", "invalid command environment"}})
			return
		}
		command.Env = append(command.Env, key+"="+value)
	}
	executable, err := processes.Executable(argv[0], command.Env, command.Dir)
	if err != nil {
		c.send(response{ID: r.ID, Error: &failure{"spawn_error", err.Error()}})
		return
	}
	command.Path, command.Err = executable, nil
	group, cleanup, err := c.commandGroup()
	if err != nil {
		c.send(response{ID: r.ID, Error: &failure{"spawn_error", err.Error()}})
		return
	}
	defer cleanup()
	command.SysProcAttr = &syscall.SysProcAttr{Setpgid: true, Credential: c.credential}
	if group != nil {
		command.SysProcAttr.UseCgroupFD = true
		command.SysProcAttr.CgroupFD = int(group.Fd())
	}
	command.Cancel = func() error {
		if command.Process == nil {
			return nil
		}
		return processes.KillGroup(group, command.Process.Pid)
	}
	command.WaitDelay = 2 * time.Second
	spool, err := os.CreateTemp("", "bay-output-*")
	if err != nil {
		c.send(response{ID: r.ID, Error: &failure{"spawn_error", err.Error()}})
		return
	}
	if c.credential != nil {
		if err := spool.Chown(int(c.credential.Uid), int(c.credential.Gid)); err != nil {
			spool.Close()
			os.Remove(spool.Name())
			c.send(response{ID: r.ID, Error: &failure{"spawn_error", err.Error()}})
			return
		}
	}
	capture := &output{connection: c, id: r.ID, file: spool, cancel: command.Cancel}
	command.Stdout = &stream{capture, "stdout"}
	command.Stderr = &stream{capture, "stderr"}
	err = command.Run()
	if command.Process != nil {
		processes.KillGroup(group, command.Process.Pid)
	}
	if err := cleanup(); err != nil {
		capture.err = err
	}
	capture.mu.Lock()
	if err := capture.file.Sync(); capture.err == nil && err != nil {
		capture.err = err
	}
	if err := capture.file.Close(); capture.err == nil && err != nil {
		capture.err = err
	}
	spill := r.Spill != nil && (capture.bytes > r.Spill.AfterBytes || capture.lines() > r.Spill.AfterLines)
	capture.mu.Unlock()
	if !spill {
		os.Remove(spool.Name())
	}
	value := map[string]any{"exitCode": 0}
	if spill {
		value["spillPath"] = spool.Name()
	}
	var failed *failure
	switch {
	case capture.err != nil:
		failed = &failure{"unknown", capture.err.Error()}
	case errors.Is(ctx.Err(), context.DeadlineExceeded):
		failed = &failure{"timeout", "command timed out"}
	case ctx.Err() != nil:
		failed = &failure{"aborted", "command aborted"}
	case err != nil:
		var exit *exec.ExitError
		if errors.As(err, &exit) {
			value["exitCode"] = exit.ExitCode()
		} else {
			failed = &failure{"spawn_error", err.Error()}
		}
	}
	c.send(response{ID: r.ID, Value: value, Error: failed})
}

type output struct {
	mu              sync.Mutex
	connection      *connection
	id              uint64
	file            *os.File
	bytes, newlines int64
	lastNewline     bool
	err             error
	cancel          func() error
}

func (o *output) lines() int64 {
	if o.bytes > 0 && !o.lastNewline {
		return o.newlines + 1
	}
	return o.newlines
}

type stream struct {
	output *output
	name   string
}

func (s *stream) Write(p []byte) (int, error) {
	o := s.output
	o.mu.Lock()
	defer o.mu.Unlock()
	if o.err != nil {
		return 0, o.err
	}
	if o.bytes+int64(len(p)) > 512<<20 {
		o.err = fmt.Errorf("command output exceeded 512 MiB")
		o.cancel()
		return 0, o.err
	}
	if _, err := o.file.Write(p); err != nil {
		o.err = err
		o.cancel()
		return 0, err
	}
	o.bytes += int64(len(p))
	for _, b := range p {
		if b == '\n' {
			o.newlines++
		}
	}
	if len(p) > 0 {
		o.lastNewline = p[len(p)-1] == '\n'
	}
	for rest := p; len(rest) > 0; {
		n := min(len(rest), maxChunk)
		if err := o.connection.send(response{ID: o.id, Stream: s.name, Data: base64.StdEncoding.EncodeToString(rest[:n])}); err != nil {
			o.err = err
			o.cancel()
			return 0, err
		}
		rest = rest[n:]
	}
	return len(p), nil
}

var _ io.Writer = (*stream)(nil)
