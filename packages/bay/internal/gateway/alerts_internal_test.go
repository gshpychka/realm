package gateway

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"sync"
	"testing"

	"github.com/gshpychka/realm/packages/bay/internal/fault"
	"github.com/gshpychka/realm/packages/bay/internal/identity"
	"github.com/gshpychka/realm/packages/bay/internal/sessionapi"
)

// probeAlerter notes the alerts it is given and the state of the context each arrives with.
type probeAlerter struct {
	mu          sync.Mutex
	events      []string
	err         error
	hasDeadline bool
}

func (a *probeAlerter) Alert(ctx context.Context, _, event string) error {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.events = append(a.events, event)
	a.err = ctx.Err()
	_, a.hasDeadline = ctx.Deadline()
	return nil
}

func newProbedGateway(a Alerter) *Gateway {
	return New(Config{Alerter: a, Log: slog.New(slog.NewTextHandler(io.Discard, nil))})
}

func TestAlertsOutliveTheirCaller(t *testing.T) {
	probe := &probeAlerter{}
	g := newProbedGateway(probe)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if err := g.alert(ctx, "alice", "done"); err != nil {
		t.Fatal(err)
	}
	if probe.err != nil || !probe.hasDeadline {
		t.Errorf("the alert's context was cancelled (%v) or unbounded (deadline: %v)", probe.err, probe.hasDeadline)
	}
}

func TestNotifyChecksTheEventItself(t *testing.T) {
	probe := &probeAlerter{}
	g := newProbedGateway(probe)
	_, err := g.notify(context.Background(), identity.Session{ID: "id-alice", Name: "alice"}, sessionapi.NotifyInput{Event: "bogus"})
	if !errors.Is(err, fault.Invalid) {
		t.Errorf("notify with an unknown event returned %v, want an invalid error", err)
	}
	if len(probe.events) != 0 {
		t.Errorf("alerts = %v, want none", probe.events)
	}
}
