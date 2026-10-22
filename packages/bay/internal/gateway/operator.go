package gateway

import (
	"cmp"
	"context"
	"fmt"

	"github.com/gshpychka/realm/packages/bay/internal/fault"
	"github.com/gshpychka/realm/packages/bay/internal/identity"
	"github.com/gshpychka/realm/packages/bay/internal/messages"
	"github.com/gshpychka/realm/packages/bay/internal/sessionapi"
)

// OperatorService returns the operator's side of g's messaging.
func (g *Gateway) OperatorService() messages.Service {
	return operatorService{g}
}

type operatorService struct {
	g *Gateway
}

func (o operatorService) Threads(ctx context.Context) ([]messages.Thread, error) {
	return o.g.store.Threads(ctx, operator)
}

func (o operatorService) Conversation(ctx context.Context, thread, before int64) (messages.Conversation, error) {
	return o.g.store.Conversation(ctx, operator, thread, before)
}

func (o operatorService) Send(ctx context.Context, s messages.Send) (messages.Message, error) {
	m, err := o.send(ctx, s)
	audit(o.g.log, messages.Operator, sessionapi.Send, err, "thread", cmp.Or(m.Thread, s.Thread), "to", s.To)
	return m, err
}

func (o operatorService) send(ctx context.Context, s messages.Send) (messages.Message, error) {
	return o.g.deliverMessage(ctx, operator, s)
}

func (o operatorService) Feed(ctx context.Context, after string) (messages.Feed, error) {
	return o.g.store.Feed(ctx, operator, after)
}

func (o operatorService) Relay(ctx context.Context, name string, r messages.Relay) (messages.Message, error) {
	if r.ID == "" || r.Generation == nil || name == messages.Operator {
		return messages.Message{}, fmt.Errorf("%w: a session relay requires its ID and execution generation", fault.Invalid)
	}
	from, err := o.g.resolver.Session(ctx, name)
	if err == nil && (from.ID == messages.Operator || from.Name == messages.Operator) {
		return messages.Message{}, fmt.Errorf("%w: a relay must name a session", fault.Forbidden)
	}
	if err == nil {
		err = (identity.Precondition{ID: r.ID, Generation: r.Generation}).Check(from)
	}
	if err != nil {
		return messages.Message{}, err
	}
	m, err := o.g.deliverMessage(ctx, participant(from), r.Send)
	audit(o.g.log, from.Name, sessionapi.Send, err, "thread", cmp.Or(m.Thread, r.Thread), "to", r.To, "relay", true, "generation", from.Generation)
	return m, err
}
