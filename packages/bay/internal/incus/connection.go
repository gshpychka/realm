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
	inst, _, err := contextual.WithContext(ctx).GetInstance(name)
	if err != nil {
		return d.notFound(err, name)
	}
	if inst.Config[sessionKey] != sessionID {
		return fmt.Errorf("%w: instance %s belongs to a different session", fault.Conflict, name)
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	// The SDK's WaitContext cancels its server-side operation and closes its
	// listener immediately when that context ends. Such a return is not proof
	// that the guest has exited. Caller cancellation controls TERM/KILL below;
	// this separate lifetime remains until a final server operation is observed.
	lifetime, release := context.WithCancel(context.WithoutCancel(ctx))
	defer release()
	server := contextual.WithContext(lifetime)
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
			control.WriteJSON(api.InstanceExecControl{Command: "signal", Signal: int(syscall.SIGTERM)})
			// The fixed environment launcher acknowledges its unit's cleanup
			// before exiting. Killing that launcher would destroy this proof
			// while a separate systemd unit could still be running.
			<-finished
		},
	}
	op, err := server.ExecInstance(name, api.InstanceExecPost{Command: argv, WaitForWS: true}, args)
	if err != nil {
		return fmt.Errorf("connect to %s: %w", name, err)
	}
	state, err := awaitConnectionExit(lifetime, contextual, op)
	if err != nil {
		return fmt.Errorf("connect to %s: %w", name, err)
	}
	if err := ctx.Err(); err != nil {
		return fmt.Errorf("connect to %s: %w", name, err)
	}
	select {
	case <-args.DataDone:
	case <-ctx.Done():
		return ctx.Err()
	}
	code, ok := state.Metadata["return"].(float64)
	if !ok {
		return fmt.Errorf("connect to %s: no exit status", name)
	}
	if code != 0 {
		return fmt.Errorf("exit status %d: %s", int(code), strings.TrimSpace(stderr.String()))
	}
	return nil
}

type contextualServer interface {
	WithContext(context.Context) incus.InstanceServer
}

func awaitConnectionExit(ctx context.Context, server contextualServer, op incus.Operation) (api.Operation, error) {
	err := op.WaitContext(ctx)
	state := op.Get()
	if state.StatusCode.IsFinal() {
		return state, err
	}
	// A lost event listener can also unblock WaitContext without a final state.
	// Each independent status request is bounded; an uncertain bridge stays
	// tracked while lifecycle requests fail closed instead of reusing its VM.
	for {
		request, cancel := context.WithTimeout(ctx, 5*time.Second)
		current, _, requestErr := server.WithContext(request).GetOperation(state.ID)
		cancel()
		if requestErr == nil && current != nil && current.StatusCode.IsFinal() {
			if current.Err != "" {
				return *current, errors.New(current.Err)
			}
			return *current, nil
		}
		select {
		case <-ctx.Done():
			return state, ctx.Err()
		case <-time.After(time.Second):
		}
	}
}
