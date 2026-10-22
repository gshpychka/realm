package sessions

import (
	"context"
	"fmt"
	"io"

	"github.com/gshpychka/realm/packages/bay/internal/fault"
	"github.com/gshpychka/realm/packages/bay/internal/guest"
)

// Connect opens the configured program endpoint, never an arbitrary guest command.
// Only one operator connection may control a program at a time. Closing it leaves
// the program running; lifecycle changes close it before touching its instance.
func (s *Service) Connect(ctx context.Context, name, id string) (io.ReadWriteCloser, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if id == "" {
		return nil, fmt.Errorf("%w: connecting requires the session ID", fault.Invalid)
	}
	release, err := s.claimSession(name, false)
	if err != nil {
		return nil, err
	}
	defer release()
	rec, err := s.record(name)
	if err != nil {
		return nil, err
	}
	if rec.ID != id {
		return nil, fmt.Errorf("%w: session %s has a different ID", fault.Conflict, name)
	}
	program, err := s.program(rec)
	if err != nil {
		return nil, err
	}
	if len(program.Connect) == 0 {
		return nil, fmt.Errorf("%w: session %s's program does not support connections", fault.Conflict, name)
	}
	if err := s.require(ctx, name, InstanceRunning); err != nil {
		return nil, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.connections[name] != nil {
		return nil, fmt.Errorf("%w: session %s already has a program connection", fault.Conflict, name)
	}
	ctx, cancel := context.WithCancel(ctx)
	in, input := io.Pipe()
	output, out := io.Pipe()
	c := &programConnection{input: input, output: output, cancel: cancel, done: make(chan struct{})}
	s.connections[name] = c
	go func() {
		g := guest.New(func(ctx context.Context, argv []string, stdin io.Reader, stdout io.Writer) error {
			return s.instances.Connect(ctx, name, id, argv, stdin, stdout)
		})
		err := g.Connect(ctx, program.Connect, in, out)
		in.CloseWithError(err)
		out.CloseWithError(err)
		cancel()
		s.mu.Lock()
		delete(s.connections, name)
		close(c.done)
		s.mu.Unlock()
	}()
	return c, nil
}

// Pipes provide backpressure without accumulating a program's output in memory.
type programConnection struct {
	input  *io.PipeWriter
	output *io.PipeReader
	cancel context.CancelFunc
	done   chan struct{}
}

func (c *programConnection) Read(p []byte) (int, error)  { return c.output.Read(p) }
func (c *programConnection) Write(p []byte) (int, error) { return c.input.Write(p) }
func (c *programConnection) CloseWrite() error           { return c.input.Close() }

func (c *programConnection) Close() error {
	c.cancel()
	c.input.Close()
	c.output.Close()
	return nil
}
