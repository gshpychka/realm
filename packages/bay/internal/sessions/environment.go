package sessions

import (
	"context"
	"fmt"
	"io"

	"github.com/gshpychka/realm/packages/bay/internal/fault"
	"github.com/gshpychka/realm/packages/bay/internal/identity"
)

// Environment opens Bay's fixed unprivileged filesystem/shell adapter. A
// lifecycle operation closes it before replacing or suspending the execution.
func (s *Service) Environment(ctx context.Context, name string, expected identity.Precondition, revision string) (io.ReadWriteCloser, error) {
	if expected.ID == "" || expected.Generation == nil || revision == "" {
		return nil, fmt.Errorf("%w: environment requires record, generation and machine revision", fault.Invalid)
	}
	rec, g, release, err := s.operatorSession(ctx, name, expected)
	if err != nil {
		return nil, err
	}
	defer release()
	if rec.Machine.Revision != revision {
		return nil, fmt.Errorf("%w: environment machine revision changed", fault.Conflict)
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	const limit = 4
	if len(s.connections[name]) >= limit {
		return nil, fmt.Errorf("%w: session %s has reached its limit of %d environment connections", fault.Conflict, name, limit)
	}
	ctx, cancel := context.WithCancel(ctx)
	in, input := io.Pipe()
	output, out := io.Pipe()
	c := &environmentConnection{input: input, output: output, cancel: cancel, done: make(chan struct{})}
	if s.connections[name] == nil {
		s.connections[name] = map[*environmentConnection]struct{}{}
	}
	s.connections[name][c] = struct{}{}
	go func() {
		err := g.Operator(ctx, rec.ID, rec.Generation, "environment", "stream", in, out)
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

// Pipes apply backpressure without buffering command output in memory.
type environmentConnection struct {
	input  *io.PipeWriter
	output *io.PipeReader
	cancel context.CancelFunc
	done   chan struct{}
}

func (c *environmentConnection) Read(p []byte) (int, error)  { return c.output.Read(p) }
func (c *environmentConnection) Write(p []byte) (int, error) { return c.input.Write(p) }
func (c *environmentConnection) CloseWrite() error           { return c.input.Close() }

func (c *environmentConnection) Close() error {
	c.cancel()
	c.input.Close()
	c.output.Close()
	return nil
}
