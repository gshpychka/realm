// Package guest drives a session's guest through the bay-session command its image provides.
package guest

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"strconv"
	"strings"
)

// Exec runs argv in one guest as root, feeding it stdin and collecting its stdout; a non-zero exit is an error.
type Exec func(ctx context.Context, argv []string, stdin io.Reader, stdout io.Writer) error

// Guest is one session's guest.
type Guest struct {
	exec Exec
}

const command = "bay-session"

// New returns the guest reached through exec.
func New(exec Exec) Guest {
	return Guest{exec: exec}
}

// Ready returns once the guest has finished booting.
func (g Guest) Ready(ctx context.Context) error {
	return g.run(ctx, nil, nil, "ready")
}

// Launch starts argv as the session's program in the session's tmux server. With monitor set, a terminal bell
// or a long silence alerts the operator.
func (g Guest) Launch(ctx context.Context, argv []string, monitor bool) error {
	mode := "quiet"
	if monitor {
		mode = "monitor"
	}
	return g.run(ctx, nil, nil, append([]string{"launch", mode, "--"}, argv...)...)
}

// Operator reaches only Bay's fixed transfer/command helper, never an arbitrary root executable.
func (g Guest) Operator(ctx context.Context, id string, generation uint64, operation, key string, stdin io.Reader, stdout io.Writer) error {
	return g.run(ctx, stdin, stdout, "operator", "--record", id, "--generation", strconv.FormatUint(generation, 10), operation, key)
}

// Running reports whether the session's program is running.
func (g Guest) Running(ctx context.Context) (bool, error) {
	var out bytes.Buffer
	if err := g.run(ctx, nil, &limited{w: &out, n: 64}, "program"); err != nil {
		return false, err
	}
	switch got := strings.TrimSpace(out.String()); got {
	case "running":
		return true, nil
	case "stopped":
		return false, nil
	default:
		return false, fmt.Errorf("%s program: unexpected output %q", command, got)
	}
}

// Stop ends the program and its tmux server, and returns once the program's processes have exited.
func (g Guest) Stop(ctx context.Context) error {
	return g.run(ctx, nil, nil, "stop")
}

// SaveHistory writes to w a tar archive of those of the given paths, relative to the program's home, that exist; the
// stream is empty when none does.
func (g Guest) SaveHistory(ctx context.Context, paths []string, w io.Writer) error {
	return g.run(ctx, nil, w, append([]string{"save-history", "--"}, paths...)...)
}

// RestoreHistory extracts the tar archive read from r into the program's home.
func (g Guest) RestoreHistory(ctx context.Context, r io.Reader) error {
	return g.run(ctx, r, nil, "restore-history")
}

// Checkout is a repo's checkout in the guest: /work/<Owner>/<Name> at Commit, with its origin pointing at Remote.
type Checkout struct {
	Owner, Name string
	// Branch is the local branch to point at Commit; empty leaves the checkout detached.
	Branch string
	Commit string
	Remote string
}

// DeliverRepo checks c out from mirror, a tar archive whose root is a bare repository holding c.Commit.
func (g Guest) DeliverRepo(ctx context.Context, c Checkout, mirror io.Reader) error {
	return g.run(ctx, mirror, nil, "deliver-repo", c.Owner+"/"+c.Name, c.Commit, c.Remote, c.Branch)
}

// AttachCommand is the guest command that attaches the caller's terminal to the session's program.
func AttachCommand() []string {
	return []string{command, "attach"}
}

func (g Guest) run(ctx context.Context, stdin io.Reader, stdout io.Writer, args ...string) error {
	argv := append([]string{command}, args...)
	if stdout == nil {
		stdout = io.Discard
	}
	if err := g.exec(ctx, argv, stdin, stdout); err != nil {
		return fmt.Errorf("%s %s: %w", command, strings.Join(args[:1], " "), err)
	}
	return nil
}

// limited writes the first n bytes it gets to w and accepts the rest unwritten.
type limited struct {
	w io.Writer
	n int
}

func (l *limited) Write(p []byte) (int, error) {
	n := len(p)
	p = p[:min(len(p), l.n)]
	l.n -= len(p)
	if _, err := l.w.Write(p); err != nil {
		return 0, err
	}
	return n, nil
}
