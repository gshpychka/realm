package gateway_test

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"slices"
	"strings"
	"testing"

	"github.com/gshpychka/realm/packages/bay/internal/fault"
	"github.com/gshpychka/realm/packages/bay/internal/messages"
	"github.com/gshpychka/realm/packages/bay/internal/sessionapi"
)

func TestOperatorSendsToASession(t *testing.T) {
	e := newEnv(t)
	op := e.gateway.OperatorService()
	as := e.connect(aliceCID)

	m, err := op.Send(context.Background(), messages.Send{To: "alice", Body: "status?\nplease report", Subject: "check-in"})
	if err != nil {
		t.Fatal(err)
	}
	if m.From != "operator" || m.To != "alice" || m.Thread == 0 || m.Body != "status?\nplease report" {
		t.Fatalf("Send returned %+v", m)
	}

	box := result[sessionapi.InboxOutput](t, call(t, as, sessionapi.Inbox, nil))
	if len(box.Threads) != 1 || box.Threads[0].ID != m.Thread || box.Threads[0].Subject != "check-in" || box.Threads[0].Unread != 1 ||
		!slices.Equal(box.Threads[0].Participants, []string{"operator", "alice"}) {
		t.Fatalf("alice's inbox = %+v", box.Threads)
	}
	conv := result[sessionapi.ReadOutput](t, call(t, as, sessionapi.Read, sessionapi.ReadInput{Thread: m.Thread}))
	if conv.Messages[0].From != "operator" {
		t.Errorf("alice reads a message from %q, want the operator", conv.Messages[0].From)
	}
	if got := e.alerter.got(); len(got) != 0 {
		t.Errorf("a message to a session raised alerts %v", got)
	}

	// alice answers in the same thread.
	reply := result[sessionapi.SendOutput](t, call(t, as, sessionapi.Send, sessionapi.SendInput{To: messages.Operator, Thread: m.Thread, Body: "all green"}))
	if reply.Thread != m.Thread {
		t.Errorf("the reply went to thread %d, want %d", reply.Thread, m.Thread)
	}
	threads, err := op.Threads(context.Background())
	if err != nil || len(threads) != 1 || threads[0].Unread != 1 || threads[0].Messages != 2 {
		t.Fatalf("Threads = %+v (%v)", threads, err)
	}
	c, err := op.Conversation(context.Background(), m.Thread, 0)
	if err != nil {
		t.Fatal(err)
	}
	if len(c.Messages) != 2 || c.Messages[1].Body != "all green" || c.Thread.Unread != 1 {
		t.Errorf("Conversation = %+v", c)
	}
	if threads, _ := op.Threads(context.Background()); threads[0].Unread != 0 {
		t.Errorf("the operator still has %d unread after reading", threads[0].Unread)
	}
}

func TestOperatorSeesEverySessionThread(t *testing.T) {
	e := newEnv(t)
	op := e.gateway.OperatorService()
	as, bs := e.connect(aliceCID), e.connect(bobCID)
	first := result[sessionapi.SendOutput](t, call(t, as, sessionapi.Send, sessionapi.SendInput{To: "bob", Body: "between us"}))
	second := result[sessionapi.SendOutput](t, call(t, bs, sessionapi.Send, sessionapi.SendInput{To: "carol", Body: "also private"}))

	threads, err := op.Threads(context.Background())
	if err != nil || len(threads) != 2 || threads[0].ID != second.Thread || threads[1].ID != first.Thread {
		t.Fatalf("Threads = %+v (%v), want both session threads, newest first", threads, err)
	}
	c, err := op.Conversation(context.Background(), first.Thread, 0)
	if err != nil || len(c.Messages) != 1 || c.Messages[0].Body != "between us" {
		t.Errorf("Conversation = %+v (%v)", c, err)
	}
	// Reading as the operator leaves the sessions' unread messages alone.
	if box := result[sessionapi.InboxOutput](t, call(t, bs, sessionapi.Inbox, nil)); len(box.Threads) != 1 || box.Threads[0].Unread != 1 {
		t.Errorf("bob's inbox = %+v, want his message still unread", box.Threads)
	}
	if _, err := op.Conversation(context.Background(), 4242, 0); !errors.Is(err, fault.NotFound) {
		t.Errorf("Conversation of a missing thread returned %v, want fault.NotFound", err)
	}
}

func TestOperatorSendRefusals(t *testing.T) {
	e := newEnv(t)
	op := e.gateway.OperatorService()
	tests := []struct {
		name string
		send messages.Send
		want error
	}{
		{"the operator", messages.Send{To: messages.Operator, Body: "note to self"}, fault.Invalid},
		{"an unknown session", messages.Send{To: "nobody", Body: "hi"}, fault.NotFound},
		{"an empty body", messages.Send{To: "alice", Body: ""}, fault.Invalid},
		{"a missing thread", messages.Send{To: "alice", Body: "hi", Thread: 55}, fault.NotFound},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if _, err := op.Send(context.Background(), tt.send); !errors.Is(err, tt.want) {
				t.Errorf("Send returned %v, want %v", err, tt.want)
			}
		})
	}
	if threads, _ := op.Threads(context.Background()); len(threads) != 0 {
		t.Errorf("refused sends left threads %+v", threads)
	}
}

func TestOperatorMayWriteToAnEndedSessionAndIntoAnyThread(t *testing.T) {
	e := newEnv(t)
	op := e.gateway.OperatorService()
	as := e.connect(aliceCID)
	between := result[sessionapi.SendOutput](t, call(t, as, sessionapi.Send, sessionapi.SendInput{To: "bob", Body: "between us"}))

	if _, err := op.Send(context.Background(), messages.Send{To: "dave", Body: "when you are back"}); err != nil {
		t.Errorf("Send to an ended session: %v", err)
	}
	m, err := op.Send(context.Background(), messages.Send{To: "alice", Thread: between.Thread, Body: "operator joins"})
	if err != nil || m.Thread != between.Thread {
		t.Fatalf("Send into a session thread returned %+v (%v)", m, err)
	}
	if got := result[sessionapi.InboxOutput](t, call(t, as, sessionapi.Inbox, nil)); len(got.Threads) != 1 || got.Threads[0].Unread != 1 {
		t.Errorf("alice's inbox = %+v", got.Threads)
	}
}

func TestOperatorSendIsAudited(t *testing.T) {
	e := newEnv(t)
	op := e.gateway.OperatorService()
	body := "an instruction nobody else may read"
	m, err := op.Send(context.Background(), messages.Send{To: "bob", Body: body, Subject: "private subject"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := op.Send(context.Background(), messages.Send{To: "nobody", Body: body}); err == nil {
		t.Fatal("Send to an unknown session succeeded")
	}

	var got []map[string]any
	for _, rec := range e.logs.lines(t) {
		if rec["tool"] != nil {
			got = append(got, rec)
		}
	}
	if len(got) != 2 {
		t.Fatalf("%d audit records, want 2:\n%s", len(got), e.logs)
	}
	sent, failed := got[0], got[1]
	if sent["level"] != "INFO" || sent["caller"] != "operator" || sent["tool"] != sessionapi.Send || sent["to"] != "bob" || sent["thread"] != float64(m.Thread) {
		t.Errorf("record of the send = %v", sent)
	}
	if failed["caller"] != "operator" || failed["to"] != "nobody" || failed["msg"] != "call refused" {
		t.Errorf("record of the refused send = %v", failed)
	}
	for _, secret := range []string{body, "private subject"} {
		if strings.Contains(e.logs.String(), secret) {
			t.Errorf("the log holds message content %q:\n%s", secret, e.logs)
		}
	}
}

// messages.Handler carries the operator's service to its clients, which see faults as their kinds.
func TestOperatorServiceOverHTTP(t *testing.T) {
	e := newEnv(t)
	srv := httptest.NewServer(messages.Handler(e.gateway.OperatorService()))
	t.Cleanup(srv.Close)
	client := messages.NewClient(srv.Client(), srv.URL)
	ctx := context.Background()
	as := e.connect(aliceCID)

	m, err := client.Send(ctx, messages.Send{To: "alice", Body: "over the wire", Subject: "wire"})
	if err != nil {
		t.Fatal(err)
	}
	result[sessionapi.SendOutput](t, call(t, as, sessionapi.Send, sessionapi.SendInput{To: messages.Operator, Thread: m.Thread, Body: "received"}))

	threads, err := client.Threads(ctx)
	if err != nil || len(threads) != 1 || threads[0].Subject != "wire" || threads[0].Unread != 1 || threads[0].Messages != 2 {
		t.Fatalf("Threads = %+v (%v)", threads, err)
	}
	c, err := client.Conversation(ctx, m.Thread, 0)
	if err != nil || len(c.Messages) != 2 || c.Messages[1].From != "alice" {
		t.Fatalf("Conversation = %+v (%v)", c, err)
	}
	page, err := client.Conversation(ctx, m.Thread, c.Messages[1].ID)
	if err != nil || len(page.Messages) != 1 || page.Messages[0].ID != m.ID || page.Earlier != 0 {
		t.Fatalf("earlier page over HTTP = %+v (%v)", page, err)
	}
	if _, err := client.Conversation(ctx, m.Thread, -1); !errors.Is(err, fault.Invalid) {
		t.Fatalf("negative HTTP cursor = %v, want invalid", err)
	}

	if _, err := client.Conversation(ctx, 999, 0); !errors.Is(err, fault.NotFound) {
		t.Errorf("Conversation of a missing thread returned %v, want fault.NotFound", err)
	}
	if _, err := client.Send(ctx, messages.Send{To: messages.Operator, Body: "self"}); !errors.Is(err, fault.Invalid) {
		t.Errorf("Send to the operator returned %v, want fault.Invalid", err)
	}
	if _, err := client.Send(ctx, messages.Send{To: "nobody", Body: "hi"}); !errors.Is(err, fault.NotFound) {
		t.Errorf("Send to an unknown session returned %v, want fault.NotFound", err)
	}
	resp, err := srv.Client().Get(srv.URL + "/threads/not-a-number")
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusBadRequest {
		t.Errorf("a malformed thread ID got status %d, want 400", resp.StatusCode)
	}
}
