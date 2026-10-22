package incus

import (
	"context"
	"errors"
	"fmt"
	"io"
	"strings"
	"syscall"
	"time"

	"github.com/gorilla/websocket"
	incus "github.com/lxc/incus/v7/client"
	"github.com/lxc/incus/v7/shared/api"

	"github.com/gshpychka/realm/packages/bay/internal/fault"
)

// Connect runs only the program's bridge. The bridge replaces bay-session in
// place, so cancelling this operation cannot signal the persistent program.
func (d *Driver) Connect(ctx context.Context, name, sessionID string, argv []string, stdin io.Reader, stdout io.Writer) error {
	// The SDK exposes WithContext on its concrete client, not InstanceServer.
	contextual, ok := d.server.(interface {
		WithContext(context.Context) incus.InstanceServer
	})
	if !ok {
		return errors.New("the Incus client cannot open cancellable connections")
	}
	server := contextual.WithContext(ctx)
	inst, _, err := server.GetInstance(name)
	if err != nil {
		return d.notFound(err, name)
	}
	if inst.Config[sessionKey] != sessionID {
		return fmt.Errorf("%w: instance %s belongs to a different session", fault.Conflict, name)
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	stderr := &head{max: stderrLimit}
	finished := make(chan struct{})
	defer close(finished)
	args := &incus.InstanceExecArgs{
		Stdin: stdin, Stdout: stdout, Stderr: stderr, DataDone: make(chan bool),
		Control: func(control *websocket.Conn) {
			defer control.Close()
			select {
			case <-ctx.Done():
			case <-finished:
				if ctx.Err() == nil {
					return
				}
			}
			control.SetWriteDeadline(time.Now().Add(5 * time.Second))
			control.WriteJSON(api.InstanceExecControl{Command: "signal", Signal: int(syscall.SIGKILL)})
		},
	}
	op, err := server.ExecInstance(name, api.InstanceExecPost{Command: argv, WaitForWS: true}, args)
	if err != nil {
		return fmt.Errorf("connect to %s: %w", name, err)
	}
	if err := op.WaitContext(ctx); err != nil {
		// Await the bridge's exit before lifecycle operations can reuse the name.
		// An unavailable guest must not keep an operator request alive forever.
		cleanup, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		op.WaitContext(cleanup)
		return fmt.Errorf("connect to %s: %w", name, err)
	}
	<-args.DataDone
	code, ok := op.Get().Metadata["return"].(float64)
	if !ok {
		return fmt.Errorf("connect to %s: no exit status", name)
	}
	if code != 0 {
		return fmt.Errorf("exit status %d: %s", int(code), strings.TrimSpace(stderr.String()))
	}
	return nil
}
