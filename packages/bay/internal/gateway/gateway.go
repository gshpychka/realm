// Package gateway is the session gateway: the one host endpoint sessions reach. It ties every call to the session that
// made it, and carries their messaging and alerts.
package gateway

import (
	"context"
	"errors"
	"fmt"
	"log/slog"

	"github.com/gshpychka/realm/packages/bay/internal/fault"
	"github.com/gshpychka/realm/packages/bay/internal/identity"
	"github.com/gshpychka/realm/packages/bay/internal/messages"
	"github.com/modelcontextprotocol/go-sdk/mcp"
)

// Participant is a party to messaging: a session, or the operator.
type Participant struct {
	// ID is the session's ID, or messages.Operator.
	ID   string
	Name string
}

// Store keeps threads and messages. It refuses with fault kinds: Invalid for a malformed message, including one with a
// body over messages.MaxBody; NotFound for a missing thread; Forbidden for a thread its caller takes no part in;
// Conflict for a recipient whose name an earlier session holds in the thread.
type Store interface {
	// Send delivers a message, starting a thread when thread is 0.
	Send(ctx context.Context, from, to Participant, thread int64, subject, body string) (messages.Message, error)
	// Inbox returns the threads holding messages to viewer that viewer has not read.
	Inbox(ctx context.Context, viewer Participant) ([]messages.Thread, error)
	// Conversation returns a page of messages before the given message ID (0 for
	// the latest) and marks only its returned messages to viewer read.
	Conversation(ctx context.Context, viewer Participant, thread, before int64) (messages.Conversation, error)
	// Threads returns every thread, to the operator only.
	Threads(ctx context.Context, viewer Participant) ([]messages.Thread, error)
}

// Alerter tells the operator that a session needs attention. Alerts leave the host, so they carry the session's name
// and the kind of event only: one of sessionapi.Events, or MessageEvent.
type Alerter interface {
	Alert(ctx context.Context, session string, event string) error
}

// MessageEvent is the event of a message awaiting the operator.
const MessageEvent = "message"

// Config is what a Gateway runs with.
type Config struct {
	Resolver identity.Resolver
	Store    Store
	// Alerter publishes alerts; with none, alerts are logged only.
	Alerter Alerter
	// Log receives the audit trail.
	Log *slog.Logger
}

// Gateway serves sessions and the operator from one message store.
type Gateway struct {
	resolver identity.Resolver
	store    Store
	alerter  Alerter
	log      *slog.Logger
	server   *mcp.Server
	// alerts is each session's allowance of alerts; every session's alerts share the operator's attention and the ntfy
	// publisher's rate limit.
	alerts *allowances[string]
	// requests is each VM's allowance of requests; every session's requests share the resolver, the store and the log.
	requests *allowances[uint32]
}

// New returns a Gateway running with c.
func New(c Config) *Gateway {
	g := &Gateway{
		resolver: c.Resolver,
		store:    c.Store,
		alerter:  c.Alerter,
		log:      c.Log,
		alerts:   newAllowances[string](alertBurst, alertRefill),
		requests: newAllowances[uint32](requestBurst, requestRefill),
	}
	g.server = g.newServer()
	return g
}

var operator = Participant{ID: messages.Operator, Name: messages.Operator}

func participant(s identity.Session) Participant {
	return Participant{ID: s.ID, Name: s.Name}
}

// recipient resolves the name a message is addressed to: the operator, or a session in any state.
func (g *Gateway) recipient(ctx context.Context, name string) (Participant, error) {
	if name == messages.Operator {
		return operator, nil
	}
	s, err := g.resolver.Session(ctx, name)
	if errors.Is(err, fault.NotFound) {
		return Participant{}, fmt.Errorf("%w: no session named %q", fault.NotFound, name)
	}
	if err != nil {
		return Participant{}, err
	}
	return participant(s), nil
}
