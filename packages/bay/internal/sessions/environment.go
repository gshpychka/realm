package sessions

import (
	"context"
	"fmt"
	"io"

	"github.com/gshpychka/realm/packages/bay/internal/fault"
	"github.com/gshpychka/realm/packages/bay/internal/guest"
	"github.com/gshpychka/realm/packages/bay/internal/identity"
)

// Environment opens Bay's fixed unprivileged filesystem/shell adapter. A
// lifecycle operation closes it before replacing or suspending the execution.
func (s *Service) Environment(ctx context.Context, name string, expected identity.Precondition, revision string) (io.ReadWriteCloser, error) {
	if expected.ID == "" || expected.Generation == nil || revision == "" {
		return nil, fmt.Errorf("%w: environment requires record, generation and machine revision", fault.Invalid)
	}
	rec, _, release, err := s.operatorSession(ctx, name, expected)
	if err != nil {
		return nil, err
	}
	defer release()
	if rec.Machine.Revision != revision {
		return nil, fmt.Errorf("%w: environment machine revision changed", fault.Conflict)
	}
	return s.openConnection(ctx, name, "environment", 4, func(ctx context.Context, g guest.Guest, in io.Reader, out io.Writer) error {
		return g.Operator(ctx, rec.ID, rec.Generation, "environment", "stream", in, out)
	}, rec.ID)
}

func (s *Service) openConnection(ctx context.Context, name, kind string, limit int, run func(context.Context, guest.Guest, io.Reader, io.Writer) error, id string) (io.ReadWriteCloser, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	count := 0
	for c := range s.connections[name] {
		if c.kind == kind {
			count++
		}
	}
	if count >= limit {
		return nil, fmt.Errorf("%w: session %s has reached its limit of %d %s connections", fault.Conflict, name, limit, kind)
	}
	ctx, cancel := context.WithCancel(ctx)
	in, input := io.Pipe()
	output, out := io.Pipe()
	c := &programConnection{kind: kind, input: input, output: output, cancel: cancel, done: make(chan struct{})}
	if s.connections[name] == nil {
		s.connections[name] = map[*programConnection]struct{}{}
	}
	s.connections[name][c] = struct{}{}
	go func() {
		g := guest.New(func(ctx context.Context, argv []string, stdin io.Reader, stdout io.Writer) error {
			return s.instances.Connect(ctx, name, id, argv, stdin, stdout)
		})
		err := run(ctx, g, in, out)
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
