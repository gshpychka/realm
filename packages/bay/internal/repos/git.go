package repos

import (
	"bytes"
	"context"
	"fmt"
	"os"
	"os/exec"
	"slices"
	"strings"
	"time"
)

// git runs the git binary in a fixed environment.
type git struct {
	path string
	env  []string
}

// newGit returns the git on PATH, run with home as its HOME.
func newGit(home string) (git, error) {
	path, err := exec.LookPath("git")
	if err != nil {
		return git{}, fmt.Errorf("repo mirrors need git: %w", err)
	}
	// Inherited GIT_* variables and user or system config change where git operates and what it does.
	env := slices.DeleteFunc(os.Environ(), func(kv string) bool { return strings.HasPrefix(kv, "GIT_") })
	env = append(env,
		"HOME="+home,
		"GIT_TERMINAL_PROMPT=0",
		// An empty GIT_ASKPASS takes precedence over SSH_ASKPASS and turns credential prompts off.
		"GIT_ASKPASS=",
		"GIT_CONFIG_NOSYSTEM=1",
		"GIT_CONFIG_GLOBAL="+os.DevNull,
		// Auto gc finishes inside the command that triggers it, while the mirror's lock is held.
		"GIT_CONFIG_COUNT=1",
		"GIT_CONFIG_KEY_0=gc.autoDetach",
		"GIT_CONFIG_VALUE_0=false",
	)
	return git{path: path, env: env}, nil
}

// run runs git with args, against the repository at dir unless dir is empty, and returns its stdout.
func (g git) run(ctx context.Context, dir string, args ...string) (string, error) {
	sub := args[0]
	if dir != "" {
		args = append([]string{"--git-dir=" + dir}, args...)
	}
	cmd := exec.CommandContext(ctx, g.path, args...)
	cmd.Env = g.env
	// git removes its lock files when interrupted.
	cmd.Cancel = func() error { return cmd.Process.Signal(os.Interrupt) }
	cmd.WaitDelay = 10 * time.Second
	var stdout, stderr bytes.Buffer
	cmd.Stdout, cmd.Stderr = &stdout, &stderr
	if err := cmd.Run(); err != nil {
		if ctx.Err() != nil {
			err = ctx.Err()
		}
		if msg := strings.TrimSpace(stderr.String()); msg != "" {
			return "", fmt.Errorf("git %s: %w: %s", sub, err, msg)
		}
		return "", fmt.Errorf("git %s: %w", sub, err)
	}
	return stdout.String(), nil
}
