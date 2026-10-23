package gateway_test

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/gshpychka/realm/packages/bay/internal/fault"
	"github.com/gshpychka/realm/packages/bay/internal/gateway"
	"github.com/gshpychka/realm/packages/bay/internal/identity"
	"github.com/gshpychka/realm/packages/bay/internal/messages"
	"github.com/gshpychka/realm/packages/bay/internal/sessionapi"
	"github.com/modelcontextprotocol/go-sdk/mcp"
)

func TestToolsAreListed(t *testing.T) {
	e := newEnv(t)
	cs := e.connect(aliceCID)
	listed, err := cs.ListTools(context.Background(), nil)
	if err != nil {
		t.Fatal(err)
	}
	var names []string
	for _, tool := range listed.Tools {
		names = append(names, tool.Name)
		if tool.Description == "" {
			t.Errorf("tool %s has no description", tool.Name)
		}
		if tool.Name != sessionapi.Notify {
			continue
		}
		var schema struct {
			Properties struct {
				Event struct {
					Enum []string `json:"enum"`
				} `json:"event"`
			} `json:"properties"`
		}
		data, err := json.Marshal(tool.InputSchema)
		if err != nil {
			t.Fatal(err)
		}
		if err := json.Unmarshal(data, &schema); err != nil {
			t.Fatalf("decoding the notify schema %s: %v", data, err)
		}
		var want []string
		for _, ev := range sessionapi.Events {
			want = append(want, string(ev))
		}
		if !slices.Equal(schema.Properties.Event.Enum, want) {
			t.Errorf("notify offers events %q, want %q", schema.Properties.Event.Enum, want)
		}
	}
	slices.Sort(names)
	want := []string{sessionapi.Inbox, sessionapi.Notify, sessionapi.Read, sessionapi.Send, sessionapi.Whoami}
	slices.Sort(want)
	if !slices.Equal(names, want) {
		t.Errorf("tools = %q, want %q", names, want)
	}
}

func TestWhoamiNamesTheCaller(t *testing.T) {
	e := newEnv(t)
	for _, tt := range []struct {
		cid  uint32
		want string
	}{{aliceCID, "alice"}, {bobCID, "bob"}, {carolCID, "carol"}} {
		cs := e.connect(tt.cid)
		if got := result[sessionapi.WhoamiOutput](t, call(t, cs, sessionapi.Whoami, nil)); got.Name != tt.want {
			t.Errorf("whoami from context ID %d = %q, want %q", tt.cid, got.Name, tt.want)
		}
	}
}

func TestEveryProtocolVersionTheSDKSpeaks(t *testing.T) {
	e := newEnv(t)
	srv := serveAs(t, e.gateway.SessionHandler(), aliceCID)
	for _, version := range mcp.SupportedProtocolVersions() {
		t.Run(version, func(t *testing.T) {
			cs, err := newClient().Connect(context.Background(), transport(srv.URL), &mcp.ClientSessionOptions{ProtocolVersion: version})
			if err != nil {
				t.Fatalf("connect: %v", err)
			}
			defer cs.Close()
			if got := result[sessionapi.WhoamiOutput](t, call(t, cs, sessionapi.Whoami, nil)); got.Name != "alice" {
				t.Errorf("whoami = %q, want alice", got.Name)
			}
		})
	}
}

func TestConcurrentCallersStayApart(t *testing.T) {
	e := newEnv(t)
	callers := map[uint32]string{aliceCID: "alice", bobCID: "bob", carolCID: "carol"}
	var wg sync.WaitGroup
	for cid, want := range callers {
		cs := e.connect(cid)
		for range 6 {
			wg.Add(1)
			go func() {
				defer wg.Done()
				for range 10 {
					res, err := cs.CallTool(context.Background(), &mcp.CallToolParams{Name: sessionapi.Whoami})
					if err != nil {
						t.Errorf("whoami as %s: %v", want, err)
						return
					}
					got, err := decode[sessionapi.WhoamiOutput](res)
					if err != nil || got.Name != want {
						t.Errorf("whoami from the VM of %s answered %q (%v)", want, got.Name, err)
						return
					}
				}
			}()
		}
	}
	wg.Wait()
}

func TestCallerIsResolvedOnEveryRequest(t *testing.T) {
	e := newEnv(t)
	srv := serveAs(t, e.gateway.SessionHandler(), aliceCID)
	cs := connect(t, srv.URL)
	whoami := func() string {
		return result[sessionapi.WhoamiOutput](t, call(t, cs, sessionapi.Whoami, nil)).Name
	}
	if got := whoami(); got != "alice" {
		t.Fatalf("whoami = %q, want alice", got)
	}

	// The VM's context ID passes to another session, as when a session ends and a new one gets the address.
	e.resolver.setCaller(aliceCID, bob)
	if got := whoami(); got != "bob" {
		t.Errorf("whoami after the context ID changed owner = %q, want bob", got)
	}

	// The VM goes away: the same open connection is refused.
	e.resolver.setCaller(aliceCID, identity.Session{})
	if status, _ := post(t, srv.URL, whoamiRequest); status != http.StatusForbidden {
		t.Errorf("a request from a context ID without a session got status %d, want 403", status)
	}
}

func TestUnidentifiedCallersAreRefused(t *testing.T) {
	e := newEnv(t)
	// A connection without a peer is not the VM with context ID 0.
	e.resolver.setCaller(0, carol)
	bare := serveWithoutPeer(t, e.gateway.SessionHandler())
	unknown := serveAs(t, e.gateway.SessionHandler(), 99)

	tests := []struct {
		name string
		base string
	}{
		{"a context ID with no session", unknown.URL},
		{"a connection without a peer", bare.URL},
	}
	sendAsStranger := `{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"send_message","arguments":{"to":"operator","body":"hello"}}}`
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			for _, body := range []string{whoamiRequest, sendAsStranger} {
				status, resp := post(t, tt.base, body)
				if status != http.StatusForbidden {
					t.Errorf("status = %d (%s), want 403", status, resp)
				}
				if !strings.Contains(resp, "forbidden") {
					t.Errorf("response %q does not say the caller is forbidden", resp)
				}
			}
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			if _, err := newClient().Connect(ctx, transport(tt.base), nil); err == nil {
				t.Error("an MCP client connected without being identified")
			}
		})
	}

	if got := e.alerter.got(); len(got) != 0 {
		t.Errorf("refused callers raised alerts %v", got)
	}
	all, err := e.store.Threads(context.Background(), operator)
	if err != nil || len(all) != 0 {
		t.Errorf("refused callers left threads %v (%v)", all, err)
	}
}

func TestSessionsCannotTakeTheOperatorsIdentity(t *testing.T) {
	e := newEnv(t)
	as := e.connect(aliceCID)
	sent := result[sessionapi.SendOutput](t, call(t, as, sessionapi.Send, sessionapi.SendInput{To: "bob", Body: "between alice and bob"}))

	e.resolver.setCaller(0, identity.Session{ID: messages.Operator, Name: "mallory"})
	e.resolver.setCaller(1, identity.Session{ID: "id-mallory", Name: messages.Operator})
	for _, cid := range []uint32{0, 1} {
		srv := serveAs(t, e.gateway.SessionHandler(), cid)
		readRequest := fmt.Sprintf(`{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"read_thread","arguments":{"thread":%d}}}`, sent.Thread)
		for _, body := range []string{whoamiRequest, readRequest} {
			if status, resp := post(t, srv.URL, body); status != http.StatusForbidden || strings.Contains(resp, "between alice and bob") {
				t.Errorf("a session holding the operator's identity at context ID %d got %d %s, want 403", cid, status, resp)
			}
		}
	}
}

func TestIdentityComesFromThePeerOnly(t *testing.T) {
	e := newEnv(t)
	forBob := result[sessionapi.SendOutput](t, call(t, e.connect(carolCID), sessionapi.Send, sessionapi.SendInput{To: "bob", Body: "for bob only"}))
	// Every header a request could carry to claim another identity.
	cs := e.connect(aliceCID,
		"X-Session", "bob", "X-Session-Name", "bob", "X-Bay-Session", "id-bob", "X-Forwarded-For", "20",
		"Authorization", "Bearer id-bob", "Mcp-Session-Id", "id-bob", "X-Vsock-Cid", "20")
	if got := result[sessionapi.WhoamiOutput](t, call(t, cs, sessionapi.Whoami, nil)); got.Name != "alice" {
		t.Fatalf("whoami with spoofed headers = %q, want alice", got.Name)
	}
	if got := result[sessionapi.InboxOutput](t, call(t, cs, sessionapi.Inbox, nil)); len(got.Threads) != 0 {
		t.Errorf("inbox with spoofed headers = %+v, want alice's empty inbox", got.Threads)
	}
	refused(t, call(t, cs, sessionapi.Inbox, map[string]any{"session": "bob"}))
	refused(t, call(t, cs, sessionapi.Read, sessionapi.ReadInput{Thread: forBob.Thread}))

	sent := result[sessionapi.SendOutput](t, call(t, cs, sessionapi.Send, sessionapi.SendInput{To: "carol", Body: "from whom?"}))
	conv, err := e.store.Conversation(context.Background(), operator, sent.Thread, 0)
	if err != nil {
		t.Fatal(err)
	}
	if got := conv.Messages[0]; got.From != "alice" {
		t.Errorf("the message came from %q, want alice", got.From)
	}

	// Tool inputs have no way to name a sender.
	for _, extra := range []string{"from", "caller", "session", "name", "id"} {
		res := call(t, cs, sessionapi.Send, map[string]any{"to": "carol", "body": "forged", extra: "bob"})
		refused(t, res)
	}
	all, _ := e.store.Threads(context.Background(), operator)
	if len(all) != 2 {
		t.Errorf("threads = %+v, want carol's and alice's only", all)
	}
	if box, _ := e.store.Inbox(context.Background(), gateway.Participant{ID: bob.ID, Name: bob.Name}); len(box) != 1 || box[0].Unread != 1 {
		t.Errorf("bob's inbox = %+v, want carol's message still unread", box)
	}
}

func TestReadPagesThroughMCP(t *testing.T) {
	e := newEnv(t)
	as, bs := e.connect(aliceCID), e.connect(bobCID)
	first := result[sessionapi.SendOutput](t, call(t, as, sessionapi.Send, sessionapi.SendInput{To: "bob", Body: "first"}))
	second := result[sessionapi.SendOutput](t, call(t, as, sessionapi.Send, sessionapi.SendInput{To: "bob", Thread: first.Thread, Body: "second"}))
	page := result[sessionapi.ReadOutput](t, call(t, bs, sessionapi.Read, sessionapi.ReadInput{Thread: first.Thread, Before: second.Message}))
	if len(page.Messages) != 1 || page.Messages[0].ID != first.Message || page.Thread.Unread != 1 || page.Earlier != 0 {
		t.Fatalf("earlier MCP page = %+v", page)
	}
	box := result[sessionapi.InboxOutput](t, call(t, bs, sessionapi.Inbox, nil))
	if len(box.Threads) != 1 || box.Threads[0].Unread != 1 {
		t.Fatalf("MCP page marked an unreturned message read: %+v", box)
	}
}

func TestSendAndReceive(t *testing.T) {
	e := newEnv(t)
	as, bs := e.connect(aliceCID), e.connect(bobCID)

	sent := result[sessionapi.SendOutput](t, call(t, as, sessionapi.Send, sessionapi.SendInput{To: "bob", Body: "ready to review?\nthe diff is up"}))
	if sent.Thread == 0 || sent.Message == 0 {
		t.Fatalf("send returned %+v", sent)
	}

	box := result[sessionapi.InboxOutput](t, call(t, bs, sessionapi.Inbox, nil))
	if len(box.Threads) != 1 {
		t.Fatalf("bob's inbox = %+v, want one thread", box.Threads)
	}
	th := box.Threads[0]
	if th.ID != sent.Thread || th.Subject != "ready to review?" || th.Unread != 1 || th.Messages != 1 || !slices.Equal(th.Participants, []string{"alice", "bob"}) {
		t.Errorf("bob's thread = %+v", th)
	}
	if got := result[sessionapi.InboxOutput](t, call(t, as, sessionapi.Inbox, nil)); len(got.Threads) != 0 {
		t.Errorf("alice's inbox = %+v, want empty", got.Threads)
	}

	conv := result[sessionapi.ReadOutput](t, call(t, bs, sessionapi.Read, sessionapi.ReadInput{Thread: sent.Thread}))
	if len(conv.Messages) != 1 || conv.Messages[0] != (messages.Message{ID: sent.Message, Thread: sent.Thread, From: "alice", To: "bob", Body: "ready to review?\nthe diff is up", Sent: conv.Messages[0].Sent, FromID: alice.ID, ToID: bob.ID, FromGeneration: alice.Generation}) {
		t.Errorf("bob reads %+v", conv.Messages)
	}
	if got := result[sessionapi.InboxOutput](t, call(t, bs, sessionapi.Inbox, nil)); len(got.Threads) != 0 {
		t.Errorf("bob's inbox after reading = %+v, want empty", got.Threads)
	}

	reply := result[sessionapi.SendOutput](t, call(t, bs, sessionapi.Send, sessionapi.SendInput{To: "alice", Body: "on it", Thread: sent.Thread}))
	if reply.Thread != sent.Thread {
		t.Errorf("the reply went to thread %d, want %d", reply.Thread, sent.Thread)
	}
	box = result[sessionapi.InboxOutput](t, call(t, as, sessionapi.Inbox, nil))
	if len(box.Threads) != 1 || box.Threads[0].ID != sent.Thread || box.Threads[0].Unread != 1 || box.Threads[0].Messages != 2 {
		t.Errorf("alice's inbox = %+v", box.Threads)
	}
	if got := e.alerter.got(); len(got) != 0 {
		t.Errorf("messages between sessions raised alerts %v", got)
	}
}

func TestSessionCannotReachAThreadItIsNotIn(t *testing.T) {
	e := newEnv(t)
	as, bs, cs := e.connect(aliceCID), e.connect(bobCID), e.connect(carolCID)
	sent := result[sessionapi.SendOutput](t, call(t, as, sessionapi.Send, sessionapi.SendInput{To: "bob", Body: "private"}))

	if msg := refused(t, call(t, cs, sessionapi.Read, sessionapi.ReadInput{Thread: sent.Thread})); !strings.Contains(msg, "forbidden") {
		t.Errorf("reading a foreign thread failed with %q, want a forbidden error", msg)
	}
	if msg := refused(t, call(t, cs, sessionapi.Send, sessionapi.SendInput{To: "alice", Body: "butting in", Thread: sent.Thread})); !strings.Contains(msg, "forbidden") {
		t.Errorf("writing to a foreign thread failed with %q, want a forbidden error", msg)
	}
	if got := result[sessionapi.InboxOutput](t, call(t, cs, sessionapi.Inbox, nil)); len(got.Threads) != 0 {
		t.Errorf("carol's inbox = %+v", got.Threads)
	}
	if msg := refused(t, call(t, cs, sessionapi.Read, sessionapi.ReadInput{Thread: 9999})); !strings.Contains(msg, "not found") {
		t.Errorf("reading a missing thread failed with %q, want a not found error", msg)
	}

	// The refused attempts left the thread and bob's unread message as they were.
	conv := result[sessionapi.ReadOutput](t, call(t, bs, sessionapi.Read, sessionapi.ReadInput{Thread: sent.Thread}))
	if len(conv.Messages) != 1 || conv.Thread.Unread != 1 || len(conv.Thread.Participants) != 2 {
		t.Errorf("bob reads %+v", conv)
	}
}

// A later session that takes a removed session's name stays out of the removed session's threads.
func TestRepliesNeverReachAnEarlierSessionByName(t *testing.T) {
	e := newEnv(t)
	ctx := context.Background()
	op := e.gateway.OperatorService()
	as, bs := e.connect(aliceCID), e.connect(bobCID)
	first := result[sessionapi.SendOutput](t, call(t, as, sessionapi.Send, sessionapi.SendInput{To: "bob", Body: "the first alice's plan"}))

	// alice's session is removed.
	e.resolver.setCaller(aliceCID, identity.Session{})
	e.resolver.setSession("alice", identity.Session{})
	if msg := refused(t, call(t, bs, sessionapi.Send, sessionapi.SendInput{To: "alice", Body: "one more thing", Thread: first.Thread})); !strings.Contains(msg, `no session named "alice"`) {
		t.Errorf("a reply to the removed session failed with %q, want a not found error", msg)
	}

	// A new session takes her name.
	e.resolver.setSession("alice", aliceAgain)
	e.resolver.setCaller(aliceAgainCID, aliceAgain)
	again := e.connect(aliceAgainCID)
	if msg := refused(t, call(t, bs, sessionapi.Send, sessionapi.SendInput{To: "alice", Body: "bob's answer", Thread: first.Thread})); !strings.Contains(msg, "conflict") {
		t.Errorf("bob's reply by name in the old thread failed with %q, want a conflict", msg)
	}
	if _, err := op.Send(ctx, messages.Send{To: "alice", Body: "the operator's note", Thread: first.Thread}); !errors.Is(err, fault.Conflict) {
		t.Errorf("the operator's reply by name in the old thread returned %v, want fault.Conflict", err)
	}
	if got := result[sessionapi.InboxOutput](t, call(t, again, sessionapi.Inbox, nil)); len(got.Threads) != 0 {
		t.Errorf("the new alice's inbox = %+v, want empty", got.Threads)
	}
	if msg := refused(t, call(t, again, sessionapi.Read, sessionapi.ReadInput{Thread: first.Thread})); !strings.Contains(msg, "forbidden") {
		t.Errorf("the new alice reading the old thread failed with %q, want a forbidden error", msg)
	}

	// bob reaches the new alice in a thread of their own, and the old thread still takes in other sessions.
	own := result[sessionapi.SendOutput](t, call(t, bs, sessionapi.Send, sessionapi.SendInput{To: "alice", Body: "hello, new alice"}))
	if box := result[sessionapi.InboxOutput](t, call(t, again, sessionapi.Inbox, nil)); len(box.Threads) != 1 || box.Threads[0].ID != own.Thread {
		t.Errorf("the new alice's inbox = %+v, want only thread %d", box.Threads, own.Thread)
	}
	result[sessionapi.SendOutput](t, call(t, bs, sessionapi.Send, sessionapi.SendInput{To: "carol", Body: "carol, your view?", Thread: first.Thread}))
	conv, err := e.store.Conversation(ctx, operator, first.Thread, 0)
	if err != nil || len(conv.Messages) != 2 || !slices.Equal(conv.Thread.Participants, []string{"alice", "bob", "carol"}) {
		t.Errorf("the old thread = %+v (%v), want the first alice's message and bob's to carol", conv, err)
	}
}

func TestSendRefusals(t *testing.T) {
	e := newEnv(t)
	as := e.connect(aliceCID)
	tests := []struct {
		name string
		in   sessionapi.SendInput
		want string
	}{
		{"unknown session", sessionapi.SendInput{To: "nobody", Body: "hi"}, `not found: no session named "nobody"`},
		{"yourself", sessionapi.SendInput{To: "alice", Body: "hi"}, "invalid"},
		{"empty body", sessionapi.SendInput{To: "bob", Body: ""}, "invalid"},
		{"blank body", sessionapi.SendInput{To: "bob", Body: " \n "}, "invalid"},
		{"missing thread", sessionapi.SendInput{To: "bob", Body: "hi", Thread: 77}, "not found"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if msg := refused(t, call(t, as, sessionapi.Send, tt.in)); !strings.Contains(msg, tt.want) {
				t.Errorf("failed with %q, want it to contain %q", msg, tt.want)
			}
		})
	}
	if all, _ := e.store.Threads(context.Background(), operator); len(all) != 0 {
		t.Errorf("refused sends left threads %+v", all)
	}
}

func TestSendToAnEndedSession(t *testing.T) {
	e := newEnv(t)
	as := e.connect(aliceCID)
	sent := result[sessionapi.SendOutput](t, call(t, as, sessionapi.Send, sessionapi.SendInput{To: "dave", Body: "when you are back"}))
	all, err := e.store.Threads(context.Background(), operator)
	if err != nil || len(all) != 1 || all[0].ID != sent.Thread || !slices.Equal(all[0].Participants, []string{"alice", "dave"}) {
		t.Errorf("threads = %+v (%v)", all, err)
	}
	// His inbox holds it for when he starts again.
	box, err := e.store.Inbox(context.Background(), gateway.Participant{ID: dave.ID, Name: dave.Name})
	if err != nil || len(box) != 1 || box[0].Unread != 1 {
		t.Errorf("dave's inbox = %+v (%v)", box, err)
	}
}

func TestMessageToTheOperatorAlerts(t *testing.T) {
	e := newEnv(t)
	as := e.connect(aliceCID)
	sent := result[sessionapi.SendOutput](t, call(t, as, sessionapi.Send, sessionapi.SendInput{To: messages.Operator, Body: "need a decision", Subject: "budget"}))

	if got, want := e.alerter.got(), []alert{{"alice", gateway.MessageEvent}}; !slices.Equal(got, want) {
		t.Errorf("alerts = %v, want %v", got, want)
	}
	all, err := e.store.Threads(context.Background(), operator)
	if err != nil || len(all) != 1 || all[0].ID != sent.Thread || all[0].Subject != "budget" || all[0].Unread != 1 {
		t.Errorf("operator's threads = %+v (%v)", all, err)
	}

	// A message between sessions stays quiet.
	call(t, as, sessionapi.Send, sessionapi.SendInput{To: "bob", Body: "no alert for this"})
	if got := e.alerter.got(); len(got) != 1 {
		t.Errorf("alerts = %v, want only the one for the operator", got)
	}
}

func TestFailedAlertDoesNotFailTheSend(t *testing.T) {
	e := newEnv(t)
	e.alerter.fail(errAlertDown)
	as := e.connect(aliceCID)
	sent := result[sessionapi.SendOutput](t, call(t, as, sessionapi.Send, sessionapi.SendInput{To: messages.Operator, Body: "still delivered"}))
	conv, err := e.store.Conversation(context.Background(), operator, sent.Thread, 0)
	if err != nil || len(conv.Messages) != 1 {
		t.Fatalf("the message was not stored: %+v (%v)", conv, err)
	}
	if !strings.Contains(e.logs.String(), "alert not delivered") {
		t.Errorf("the failed alert is not in the log:\n%s", e.logs)
	}
}

func TestNotifyAlertsWithTheSessionAndEventOnly(t *testing.T) {
	e := newEnv(t)
	as, bs := e.connect(aliceCID), e.connect(bobCID)
	for _, event := range sessionapi.Events {
		result[sessionapi.NotifyOutput](t, call(t, as, sessionapi.Notify, sessionapi.NotifyInput{Event: event}))
	}
	result[sessionapi.NotifyOutput](t, call(t, bs, sessionapi.Notify, sessionapi.NotifyInput{Event: sessionapi.Blocked}))

	want := []alert{{"alice", "done"}, {"alice", "blocked"}, {"alice", "idle"}, {"bob", "blocked"}}
	if got := e.alerter.got(); !slices.Equal(got, want) {
		t.Errorf("alerts = %v, want %v", got, want)
	}
}

func TestNotifyRejectsEventsOutsideTheContract(t *testing.T) {
	e := newEnv(t)
	as := e.connect(aliceCID)
	tests := []struct {
		name string
		args any
	}{
		{"free text", map[string]any{"event": "finished the migration, details in the log"}},
		{"wrong case", map[string]any{"event": "DONE"}},
		{"the gateway's own kind", map[string]any{"event": gateway.MessageEvent}},
		{"empty", map[string]any{"event": ""}},
		{"missing", map[string]any{}},
		{"not a string", map[string]any{"event": 3}},
		{"extra property", map[string]any{"event": "done", "body": "details"}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			refused(t, call(t, as, sessionapi.Notify, tt.args))
		})
	}
	if got := e.alerter.got(); len(got) != 0 {
		t.Errorf("rejected events raised alerts %v", got)
	}
}

func TestSessionsAreToldNothingAboutInternalFailures(t *testing.T) {
	t.Run("alert", func(t *testing.T) {
		e := newEnv(t)
		e.alerter.fail(errAlertDown)
		msg := refused(t, call(t, e.connect(aliceCID), sessionapi.Notify, sessionapi.NotifyInput{Event: sessionapi.Done}))
		if msg != "internal error" {
			t.Errorf("failed with %q, want a bare internal error", msg)
		}
		if !strings.Contains(e.logs.String(), errAlertDown.Error()) {
			t.Errorf("the cause is missing from the log:\n%s", e.logs)
		}
	})
	t.Run("store", func(t *testing.T) {
		e := newEnv(t, withStore(brokenStore{}))
		cs := e.connect(aliceCID)
		for tool, args := range map[string]any{
			sessionapi.Inbox: nil,
			sessionapi.Read:  sessionapi.ReadInput{Thread: 1},
			sessionapi.Send:  sessionapi.SendInput{To: "bob", Body: "hi"},
		} {
			if msg := refused(t, call(t, cs, tool, args)); msg != "internal error" {
				t.Errorf("%s failed with %q, want a bare internal error", tool, msg)
			}
		}
		if !strings.Contains(e.logs.String(), errDiskGone.Error()) {
			t.Errorf("the cause is missing from the log:\n%s", e.logs)
		}
	})
	t.Run("identity", func(t *testing.T) {
		e := newEnv(t)
		cs := e.connect(aliceCID)
		e.resolver.failSessions(errIdentityDown)
		if msg := refused(t, call(t, cs, sessionapi.Send, sessionapi.SendInput{To: "bob", Body: "hi"})); msg != "internal error" {
			t.Errorf("failed with %q, want a bare internal error", msg)
		}
	})
}

func TestIdentityOutageIsNotAnUnknownCaller(t *testing.T) {
	e := newEnv(t)
	srv := serveAs(t, e.gateway.SessionHandler(), aliceCID)
	e.resolver.failCallers(errIdentityDown)
	status, body := post(t, srv.URL, whoamiRequest)
	if status != http.StatusInternalServerError || strings.Contains(body, errIdentityDown.Error()) {
		t.Errorf("status %d with %q, want 500 without the cause", status, body)
	}
}

func TestNilAlerterLogsAlerts(t *testing.T) {
	e := newEnv(t, withoutAlerter)
	as := e.connect(aliceCID)
	result[sessionapi.NotifyOutput](t, call(t, as, sessionapi.Notify, sessionapi.NotifyInput{Event: sessionapi.Blocked}))
	result[sessionapi.SendOutput](t, call(t, as, sessionapi.Send, sessionapi.SendInput{To: messages.Operator, Body: "hello"}))

	var alerts []string
	for _, rec := range e.logs.lines(t) {
		if rec["msg"] == "alert" {
			alerts = append(alerts, rec["session"].(string)+"/"+rec["event"].(string))
		}
	}
	if want := []string{"alice/blocked", "alice/message"}; !slices.Equal(alerts, want) {
		t.Errorf("logged alerts = %v, want %v", alerts, want)
	}
}

func TestAuditTrail(t *testing.T) {
	e := newEnv(t)
	as, cs := e.connect(aliceCID), e.connect(carolCID)
	secretBody, secretSubject := "the launch code is 0451", "launch codes"
	sent := result[sessionapi.SendOutput](t, call(t, as, sessionapi.Send, sessionapi.SendInput{To: "bob", Body: secretBody, Subject: secretSubject}))
	call(t, as, sessionapi.Whoami, nil)
	call(t, as, sessionapi.Inbox, nil)
	call(t, as, sessionapi.Read, sessionapi.ReadInput{Thread: sent.Thread})
	call(t, as, sessionapi.Notify, sessionapi.NotifyInput{Event: sessionapi.Done})
	call(t, cs, sessionapi.Read, sessionapi.ReadInput{Thread: sent.Thread}) // refused

	type entry struct {
		caller, tool string
		thread       float64
		to           string
		refused      bool
	}
	var got []entry
	for _, rec := range e.logs.lines(t) {
		if rec["tool"] == nil {
			continue
		}
		en := entry{caller: rec["caller"].(string), tool: rec["tool"].(string), refused: rec["msg"] == "call refused"}
		en.thread, _ = rec["thread"].(float64)
		en.to, _ = rec["to"].(string)
		if rec["level"] != "INFO" {
			t.Errorf("record %v is not at Info", rec)
		}
		got = append(got, en)
	}
	thread := float64(sent.Thread)
	want := []entry{
		{caller: "alice", tool: sessionapi.Send, thread: thread, to: "bob"},
		{caller: "alice", tool: sessionapi.Whoami},
		{caller: "alice", tool: sessionapi.Inbox},
		{caller: "alice", tool: sessionapi.Read, thread: thread},
		{caller: "alice", tool: sessionapi.Notify},
		{caller: "carol", tool: sessionapi.Read, thread: thread, refused: true},
	}
	if !slices.Equal(got, want) {
		t.Errorf("audit trail:\n got %+v\nwant %+v", got, want)
	}
	for _, secret := range []string{secretBody, secretSubject} {
		if strings.Contains(e.logs.String(), secret) {
			t.Errorf("the log holds message content %q:\n%s", secret, e.logs)
		}
	}
}

func TestRefusedCallsAreAudited(t *testing.T) {
	e := newEnv(t)
	srv := serveAs(t, e.gateway.SessionHandler(), aliceCID)
	cs := connect(t, srv.URL)
	secret := "the launch code is 0451"

	// The MCP layer refuses these before any tool runs, and its own text for them quotes the arguments.
	for tool, args := range map[string]any{
		sessionapi.Notify: map[string]any{"event": secret},
		sessionapi.Send:   map[string]any{"to": "bob", "body": map[string]any{"text": secret}},
		sessionapi.Read:   map[string]any{"thread": secret},
	} {
		refused(t, call(t, cs, tool, args))
	}
	unknown := `{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"delete_everything","arguments":{"body":"` + secret + `"}}}`
	if _, body := post(t, srv.URL, unknown); !strings.Contains(body, `"error"`) || !strings.Contains(body, "unknown tool") {
		t.Fatalf("a call to an unknown tool got %s, want a JSON-RPC error", body)
	}
	result[sessionapi.WhoamiOutput](t, call(t, cs, sessionapi.Whoami, nil))

	reasons := map[string]string{}
	var refusals, calls []string
	for _, rec := range e.logs.lines(t) {
		tool, _ := rec["tool"].(string)
		switch {
		case tool == "":
		case rec["caller"] != "alice" || rec["level"] != "INFO":
			t.Errorf("record %v is not alice's at Info", rec)
		case rec["msg"] == "call refused":
			refusals = append(refusals, tool)
			reasons[tool], _ = rec["err"].(string)
		default:
			calls = append(calls, tool)
		}
	}
	slices.Sort(refusals)
	if want := []string{"delete_everything", sessionapi.Notify, sessionapi.Read, sessionapi.Send}; !slices.Equal(refusals, want) {
		t.Errorf("refused calls audited = %q, want %q", refusals, want)
	}
	if want := []string{sessionapi.Whoami}; !slices.Equal(calls, want) {
		t.Errorf("accepted calls audited = %q, want exactly one record for %q", calls, want)
	}
	if got, want := reasons["delete_everything"], "invalid: unknown tool"; got != want {
		t.Errorf("a call to an unknown tool was audited as %q, want %q", got, want)
	}
	if got, want := reasons[sessionapi.Send], "invalid: arguments outside the tool's schema"; got != want {
		t.Errorf("a call with arguments outside the schema was audited as %q, want %q", got, want)
	}
	if strings.Contains(e.logs.String(), secret) {
		t.Errorf("the log holds what the refused calls carried, %q:\n%s", secret, e.logs)
	}
}
