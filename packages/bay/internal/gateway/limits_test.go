package gateway_test

import (
	"context"
	"errors"
	"net/http"
	"strings"
	"testing"

	"github.com/gshpychka/realm/packages/bay/internal/fault"
	"github.com/gshpychka/realm/packages/bay/internal/messages"
	"github.com/gshpychka/realm/packages/bay/internal/sessionapi"
)

func TestMessageBodyLimit(t *testing.T) {
	e := newEnv(t)
	as := e.connect(aliceCID)
	op := e.gateway.OperatorService()
	ctx := context.Background()

	atLimit := strings.Repeat("x", messages.MaxBody)
	sent := result[sessionapi.SendOutput](t, call(t, as, sessionapi.Send, sessionapi.SendInput{To: "bob", Body: atLimit}))
	conv, err := e.store.Conversation(ctx, operator, sent.Thread)
	if err != nil || len(conv.Messages) != 1 || conv.Messages[0].Body != atLimit {
		t.Fatalf("a body of %d bytes was not stored whole: %v", messages.MaxBody, err)
	}

	tooLong := atLimit + "x"
	if msg := refused(t, call(t, as, sessionapi.Send, sessionapi.SendInput{To: "bob", Body: tooLong})); !strings.Contains(msg, "invalid") {
		t.Errorf("a body of %d bytes failed with %q, want an invalid error", len(tooLong), msg)
	}
	if msg := refused(t, call(t, as, sessionapi.Send, sessionapi.SendInput{To: "bob", Body: tooLong, Thread: sent.Thread})); !strings.Contains(msg, "invalid") {
		t.Errorf("a reply of %d bytes failed with %q, want an invalid error", len(tooLong), msg)
	}
	if _, err := op.Send(ctx, messages.Send{To: "bob", Body: tooLong}); !errors.Is(err, fault.Invalid) {
		t.Errorf("the operator's body of %d bytes returned %v, want fault.Invalid", len(tooLong), err)
	}

	all, err := e.store.Threads(ctx, operator)
	if err != nil || len(all) != 1 || all[0].Messages != 1 {
		t.Errorf("threads = %+v (%v), want only the message at the limit", all, err)
	}
}

// A request has room for a message body of MaxBody bytes written as six-byte JSON escapes, and larger requests are
// refused before any tool runs.
func TestRequestSizeLimit(t *testing.T) {
	e := newEnv(t)
	srv := serveAs(t, e.gateway.SessionHandler(), aliceCID)
	cs := connect(t, srv.URL)

	escaped := strings.Repeat("\x01", messages.MaxBody)
	result[sessionapi.SendOutput](t, call(t, cs, sessionapi.Send, sessionapi.SendInput{To: "bob", Body: escaped}))

	huge := `{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"send_message","arguments":{"to":"bob","body":"` +
		strings.Repeat("x", 2<<20) + `"}}}`
	if status, _ := post(t, srv.URL, huge); status != http.StatusRequestEntityTooLarge {
		t.Errorf("a request of %d bytes got status %d, want 413", len(huge), status)
	}
	all, err := e.store.Threads(context.Background(), operator)
	if err != nil || len(all) != 1 {
		t.Errorf("threads = %+v (%v), want only the message that fit", all, err)
	}
}

func TestAlertsAreLimitedPerSession(t *testing.T) {
	e := newEnv(t)
	as, bs := e.connect(aliceCID), e.connect(bobCID)

	// Every notification succeeds, and those past alice's allowance raise no alert.
	const notifications = 20
	for range notifications {
		result[sessionapi.NotifyOutput](t, call(t, as, sessionapi.Notify, sessionapi.NotifyInput{Event: sessionapi.Blocked}))
	}
	delivered := len(e.alerter.got())
	if delivered == 0 || delivered == notifications {
		t.Fatalf("%d of alice's %d notifications raised alerts, want a limit above none and below all", delivered, notifications)
	}

	// A message to the operator is delivered, and its alert is dropped since the allowance is spent.
	sent := result[sessionapi.SendOutput](t, call(t, as, sessionapi.Send, sessionapi.SendInput{To: messages.Operator, Body: "still delivered"}))
	conv, err := e.store.Conversation(context.Background(), operator, sent.Thread)
	if err != nil || len(conv.Messages) != 1 {
		t.Errorf("the message was not stored: %+v (%v)", conv, err)
	}
	if got := len(e.alerter.got()); got != delivered {
		t.Errorf("a message past the allowance raised an alert: %d alerts, want %d", got, delivered)
	}
	dropped := 0
	for _, rec := range e.logs.lines(t) {
		if rec["msg"] == "alert dropped" && rec["session"] == "alice" {
			dropped++
		}
	}
	if want := notifications + 1 - delivered; dropped != want {
		t.Errorf("the log holds %d dropped alerts, want %d", dropped, want)
	}

	// bob has an allowance of his own.
	result[sessionapi.NotifyOutput](t, call(t, bs, sessionapi.Notify, sessionapi.NotifyInput{Event: sessionapi.Done}))
	if got := e.alerter.got(); len(got) != delivered+1 || got[delivered] != (alert{"bob", "done"}) {
		t.Errorf("alerts = %v, want bob's after alice's %d", got, delivered)
	}
}

func TestRequestsAreLimitedPerVM(t *testing.T) {
	e := newEnv(t)
	handler := e.gateway.SessionHandler()

	served := untilRefused(t, serveAs(t, handler, aliceCID).URL)
	for i, status := range served {
		if status != http.StatusOK {
			t.Fatalf("request %d from alice's VM got status %d, want it served", i+1, status)
		}
	}
	calls := 0
	for _, rec := range e.logs.lines(t) {
		if rec["tool"] == sessionapi.Whoami {
			calls++
		}
	}
	if calls != len(served) {
		t.Errorf("the audit trail holds %d calls, want the %d served", calls, len(served))
	}

	// bob's VM has an allowance of its own.
	if status, body := post(t, serveAs(t, handler, bobCID).URL, whoamiRequest); status != http.StatusOK {
		t.Errorf("bob's request got %d %s, want it served", status, body)
	}

	// While identity is down, a VM's requests fail until its allowance runs out, and the rest are refused before any
	// lookup.
	e.resolver.failCallers(errIdentityDown)
	for i, status := range untilRefused(t, serveAs(t, handler, carolCID).URL) {
		if status != http.StatusInternalServerError {
			t.Fatalf("request %d from carol's VM got status %d while identity is down, want 500", i+1, status)
		}
	}
}

// untilRefused sends whoami requests to the endpoint under base until one is refused as a conflict, and returns the
// statuses of the requests before it.
func untilRefused(t *testing.T, base string) []int {
	t.Helper()
	const tries = 1000
	var statuses []int
	for range tries {
		status, body := post(t, base, whoamiRequest)
		if status == http.StatusConflict {
			if !strings.Contains(body, "conflict") {
				t.Errorf("the refusal %s does not say it is a conflict", body)
			}
			if len(statuses) == 0 {
				t.Fatal("the first request was refused")
			}
			return statuses
		}
		statuses = append(statuses, status)
	}
	t.Fatalf("none of %d requests was refused", tries)
	return nil
}
