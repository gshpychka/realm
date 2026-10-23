package main

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"os/signal"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/gshpychka/realm/packages/bay/internal/environment"
	"github.com/gshpychka/realm/packages/bay/internal/operations"
	"github.com/gshpychka/realm/packages/bay/internal/processes"
)

// The privileged launcher gives the disposable user process a control group.
// Closing its pipe or losing the operator also stops grandchildren that setsid.
func environmentBridge(user, home, work string) error {
	if os.Geteuid() != 0 {
		return fmt.Errorf("environment launcher requires the guest operator")
	}
	executable, err := os.Executable()
	if err != nil {
		return err
	}
	unit := "bay-environment-" + operations.Digest([]any{os.Getpid(), time.Now().UnixNano()})[:32]
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGTERM, syscall.SIGINT)
	defer stop()
	command := exec.Command("systemd-run", "--quiet", "--wait", "--pipe", "--collect", "--unit="+unit,
		"--property=WorkingDirectory="+work, "--property=KillMode=control-group", "--property=NoNewPrivileges=yes", "--property=TimeoutStopSec=2s",
		executable, "--user", user, "--home", home, "--work", work, "environment-supervisor", "stream")
	command.Stdin = os.Stdin
	command.Stdout = os.Stdout
	command.Stderr = os.Stderr
	if err := command.Start(); err != nil {
		return err
	}
	done := make(chan error, 1)
	go func() { done <- command.Wait() }()
	finished := false
	var cause error
	select {
	case err := <-done:
		if err == nil {
			return nil
		}
		finished, cause = true, err
	case <-ctx.Done():
		cause = ctx.Err()
	}
	// A failed systemd-run frontend can leave its service alive. Keep the
	// launcher until the manager independently confirms that service stopped.
	// The host bounds lifecycle waits and refuses to change this VM meanwhile.
	for {
		if err := stopEnvironmentUnit(unit); err == nil {
			if !finished {
				command.Process.Kill()
				<-done
			}
			return cause
		}
		if !finished {
			select {
			case err := <-done:
				if err == nil {
					return cause
				}
				finished = true
			default:
			}
		}
		time.Sleep(250 * time.Millisecond)
	}
}

func stopEnvironmentUnit(unit string) error {
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	if err := exec.CommandContext(ctx, "systemctl", "stop", unit+".service").Run(); err == nil {
		return nil
	}
	output, err := exec.CommandContext(ctx, "systemctl", "show", "--property=LoadState", "--property=ActiveState", unit+".service").Output()
	if ctx.Err() != nil {
		return ctx.Err()
	}
	for _, line := range strings.Split(string(output), "\n") {
		if line == "LoadState=not-found" || line == "ActiveState=inactive" || line == "ActiveState=failed" {
			return nil
		}
	}
	if err == nil {
		return fmt.Errorf("environment unit has not stopped")
	}
	return fmt.Errorf("environment unit cleanup is unconfirmed: %w", err)
}

// Only this process manages command cgroups. The file helper and every command
// run as dev and have no permission to migrate into the parent cgroup.
func superviseEnvironment(user, home, work string) error {
	if os.Geteuid() != 0 {
		return fmt.Errorf("environment supervisor requires the guest operator")
	}
	credential, err := processes.Credentials(user)
	if err != nil {
		return err
	}
	if credential == nil || credential.Uid == 0 {
		return fmt.Errorf("environment command account must be unprivileged")
	}
	executable, err := os.Executable()
	if err != nil {
		return err
	}
	env := []string{"HOME=" + home, "USER=" + user, "LOGNAME=" + user, "LANG=C.UTF-8",
		"PATH=/run/wrappers/bin:/etc/profiles/per-user/" + user + "/bin:/run/current-system/sw/bin"}
	files := exec.Command(executable, "environment-files")
	files.SysProcAttr = &syscall.SysProcAttr{Credential: credential}
	files.Dir, files.Env, files.Stderr = work, env, os.Stderr
	input, err := files.StdinPipe()
	if err != nil {
		return err
	}
	defer input.Close()
	output, err := files.StdoutPipe()
	if err != nil {
		return err
	}
	defer output.Close()
	if err := files.Start(); err != nil {
		return err
	}
	serveErr := (environment.Operator{FileInput: output, FileOutput: input, Credential: credential, Environment: env}).Serve(os.Stdin, os.Stdout)
	input.Close()
	if serveErr != nil {
		files.Process.Kill()
	}
	return errors.Join(serveErr, files.Wait())
}

// Parse the account once in the root launcher; an accidentally root-configured
// machine must not turn a model's environment into a privileged shell.
func nonRootUser(name string) error {
	output, err := exec.Command("id", "-u", name).Output()
	if err != nil {
		return err
	}
	id, err := strconv.Atoi(stringTrim(output))
	if err != nil || id == 0 {
		return fmt.Errorf("environment user must be unprivileged")
	}
	return nil
}
func stringTrim(data []byte) string {
	for len(data) > 0 && (data[len(data)-1] == '\n' || data[len(data)-1] == '\r') {
		data = data[:len(data)-1]
	}
	return string(data)
}
