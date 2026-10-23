package gateway_test

import (
	"context"
	"errors"
	"testing"

	"github.com/gshpychka/realm/packages/bay/internal/fault"
	"github.com/gshpychka/realm/packages/bay/internal/identity"
	"github.com/gshpychka/realm/packages/bay/internal/messages"
	"github.com/gshpychka/realm/packages/bay/internal/sessionapi"
)

func TestSendReceiptPrecedesRecipientResolution(t *testing.T) {
	e := newEnv(t)
	op := e.gateway.OperatorService()
	input := messages.Send{To: alice.Name, ToID: alice.ID, ClientID: "operator-logical-send", Body: "for the first alice"}
	first, err := op.Send(context.Background(), input)
	if err != nil {
		t.Fatal(err)
	}
	e.resolver.setSession(alice.Name, identity.Session{})
	if retried, err := op.Send(context.Background(), input); err != nil || retried.ID != first.ID {
		t.Fatalf("receipt after recipient removal = %+v, %v", retried, err)
	}
	e.resolver.setSession(alice.Name, aliceAgain)
	if retried, err := op.Send(context.Background(), input); err != nil || retried.ID != first.ID || retried.ToID != alice.ID {
		t.Fatalf("receipt after name reuse = %+v, %v", retried, err)
	}
	input.ClientID = "another-send"
	if _, err := op.Send(context.Background(), input); !errors.Is(err, fault.Conflict) {
		t.Fatalf("recipient precondition = %v", err)
	}
}

func TestGuestMailKeepsVsockIdentityAndIdempotency(t *testing.T) {
	e := newEnv(t)
	as := e.connect(aliceCID)
	input := sessionapi.SendInput{To: messages.Operator, ClientID: "native-tool-call", Body: "from the authenticated guest"}
	first := result[sessionapi.SendOutput](t, call(t, as, sessionapi.Send, input))
	again := result[sessionapi.SendOutput](t, call(t, as, sessionapi.Send, input))
	if first != again {
		t.Fatal("guest retry duplicated mail")
	}
	page, err := e.gateway.OperatorService().Conversation(context.Background(), first.Thread, 0)
	if err != nil || len(page.Messages) != 1 || page.Messages[0].FromID != alice.ID {
		t.Fatalf("guest provenance = %+v, %v", page, err)
	}
}
