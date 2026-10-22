package gateway

import (
	"cmp"
	"context"

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

func (o operatorService) Conversation(ctx context.Context, thread int64) (messages.Conversation, error) {
	return o.g.store.Conversation(ctx, operator, thread)
}

func (o operatorService) Send(ctx context.Context, s messages.Send) (messages.Message, error) {
	m, err := o.send(ctx, s)
	audit(o.g.log, messages.Operator, sessionapi.Send, err, "thread", cmp.Or(m.Thread, s.Thread), "to", s.To)
	return m, err
}

func (o operatorService) send(ctx context.Context, s messages.Send) (messages.Message, error) {
	to, err := o.g.recipient(ctx, s.To)
	if err != nil {
		return messages.Message{}, err
	}
	return o.g.store.Send(ctx, operator, to, s.Thread, s.Subject, s.Body)
}
