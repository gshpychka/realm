package sessions

import (
	"context"
	"fmt"
	"io"

	"github.com/gshpychka/realm/packages/bay/internal/fault"
	"github.com/gshpychka/realm/packages/bay/internal/guest"
	"github.com/gshpychka/realm/packages/bay/internal/identity"
)

// Connect opens the configured program endpoint, never an arbitrary guest command.
// The configured limit bounds operator bridges. Closing them leaves the program
// running; lifecycle changes close them before touching its instance.
func (s *Service) Connect(ctx context.Context, name, id string, generation ...uint64) (io.ReadWriteCloser, error) {
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
	expected := identity.Precondition{ID: id}
	if len(generation) > 0 {
		expected.Generation = &generation[0]
	}
	if err := checkExpected(rec, []identity.Precondition{expected}); err != nil {
		return nil, err
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
	limit := program.MaxConnections
	if limit == 0 {
		limit = 1
	}
	if len(s.connections[name]) >= limit {
		return nil, fmt.Errorf("%w: session %s has reached its limit of %d program connections", fault.Conflict, name, limit)
	}
	ctx, cancel := context.WithCancel(ctx)
	in, input := io.Pipe()
	output, out := io.Pipe()
	c := &programConnection{input: input, output: output, cancel: cancel, done: make(chan struct{})}
	if s.connections[name] == nil {
		s.connections[name] = map[*programConnection]struct{}{}
	}
	s.connections[name][c] = struct{}{}
	go func() {
		g := guest.New(func(ctx context.Context, argv []string, stdin io.Reader, stdout io.Writer) error {
			return s.instances.Connect(ctx, name, id, argv, stdin, stdout)
		})
		err := g.Connect(ctx, program.Connect, in, out)
		in.CloseWithError(err)
		out.CloseWithError(err)
		cancel()
		s.mu.Lock()
		delete(s.connections[name], c)
		if len(s.connections[name]) == 0 {
			delete(s.connections, name)
		}
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
