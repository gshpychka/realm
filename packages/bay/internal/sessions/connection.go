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
	limit := program.MaxConnections
	if limit == 0 {
		limit = 1
	}
	return s.openConnection(ctx, name, "program", limit, func(ctx context.Context, g guest.Guest, in io.Reader, out io.Writer) error {
		return g.Connect(ctx, program.Connect, in, out)
	}, id)
}

// Pipes provide backpressure without accumulating a program's output in memory.
type programConnection struct {
	kind   string
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
