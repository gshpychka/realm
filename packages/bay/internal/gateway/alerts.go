package gateway

import (
	"context"
	"time"

	"github.com/gshpychka/realm/packages/bay/internal/ntfy"
	"github.com/gshpychka/realm/packages/bay/internal/sessionapi"
)

// alertTimeout bounds one alert.
const alertTimeout = 10 * time.Second

// A session may raise alertBurst alerts at once, and one more each alertRefill.
const (
	alertBurst  = 5
	alertRefill = time.Minute
)

// alert tells the operator that session raised event, whether or not its caller waits. An alert past the session's
// allowance is dropped.
func (g *Gateway) alert(ctx context.Context, session, event string) error {
	if !g.alerts.allow(session, time.Now()) {
		g.log.Info("alert dropped", "session", session, "event", event)
		return nil
	}
	g.log.Info("alert", "session", session, "event", event)
	if g.alerter == nil {
		return nil
	}
	ctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), alertTimeout)
	defer cancel()
	return g.alerter.Alert(ctx, session, event)
}

// NtfyAlerter returns an Alerter publishing through client, with the session's name as the title and the event as
// the text.
func NtfyAlerter(client *ntfy.Client) Alerter {
	return ntfyAlerter{client: client}
}

type ntfyAlerter struct {
	client *ntfy.Client
}

// look is how an event appears on the operator's devices.
type look struct {
	tag      string
	priority int
}

var looks = map[string]look{
	string(sessionapi.Done):    {tag: "white_check_mark"},
	string(sessionapi.Idle):    {tag: "zzz"},
	string(sessionapi.Blocked): {tag: "warning", priority: ntfy.PriorityHigh},
	MessageEvent:               {tag: "envelope", priority: ntfy.PriorityHigh},
}

func (a ntfyAlerter) Alert(ctx context.Context, session, event string) error {
	l := looks[event]
	n := ntfy.Notification{Title: session, Message: event, Priority: l.priority}
	if l.tag != "" {
		n.Tags = []string{l.tag}
	}
	return a.client.Publish(ctx, n)
}
