package gateway_test

import (
	"context"
	"errors"
	"net/http/httptest"
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

func TestSessionRelayIsFencedAndFeedDoesNotReadOperatorInbox(t *testing.T) {
	e := newEnv(t)
	sender := alice
	sender.Generation = 3
	e.resolver.setSession(sender.Name, sender)
	e.resolver.setCaller(aliceCID, sender)
	srv := httptest.NewServer(messages.Handler(e.gateway.OperatorService()))
	defer srv.Close()
	client := messages.NewClient(srv.Client(), srv.URL)
	ctx := context.Background()
	generation := sender.Generation
	relay := messages.Relay{ID: sender.ID, Generation: &generation, Send: messages.Send{To: messages.Operator, ToID: messages.Operator, ClientID: "agent-tool-call", Body: "a question for the operator"}}
	m, err := client.Relay(ctx, sender.Name, relay)
	if err != nil || m.From != sender.Name || m.FromID != sender.ID || m.FromGeneration != 3 || m.ToID != messages.Operator {
		t.Fatalf("relay = %+v, %v", m, err)
	}
	if retried, err := client.Relay(ctx, sender.Name, relay); err != nil || retried.ID != m.ID {
		t.Fatalf("relay retry = %+v, %v", retried, err)
	}
	page, err := client.Feed(ctx, "")
	if err != nil || len(page.Messages) != 1 || page.Messages[0].ID != m.ID {
		t.Fatalf("mail feed = %+v, %v", page, err)
	}
	threads, err := client.Threads(ctx)
	if err != nil || len(threads) != 1 || threads[0].Unread != 1 {
		t.Fatalf("observer cleared operator inbox: %+v, %v", threads, err)
	}
	if len(e.alerter.got()) != 1 {
		t.Fatal("retry repeated the alert")
	}
	sender.Generation++
	e.resolver.setSession(sender.Name, sender)
	if _, err := client.Relay(ctx, sender.Name, relay); !errors.Is(err, fault.Conflict) {
		t.Fatalf("stale execution relay = %v", err)
	}
	relay.Generation = nil
	if _, err := client.Relay(ctx, sender.Name, relay); !errors.Is(err, fault.Invalid) {
		t.Fatalf("unfenced relay = %v", err)
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
	page, err := e.gateway.OperatorService().Feed(context.Background(), "")
	if err != nil || len(page.Messages) != 1 || page.Messages[0].FromID != alice.ID {
		t.Fatalf("guest provenance = %+v, %v", page, err)
	}
}
