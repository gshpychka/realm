package store_test

import (
	"context"
	"errors"
	"fmt"
	"path/filepath"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/gshpychka/realm/packages/bay/internal/fault"
	"github.com/gshpychka/realm/packages/bay/internal/gateway"
	"github.com/gshpychka/realm/packages/bay/internal/gateway/store"
	"github.com/gshpychka/realm/packages/bay/internal/messages"
)

var (
	operator = gateway.Participant{ID: messages.Operator, Name: messages.Operator}
	alice    = gateway.Participant{ID: "id-alice", Name: "alice"}
	bob      = gateway.Participant{ID: "id-bob", Name: "bob"}
	carol    = gateway.Participant{ID: "id-carol", Name: "carol"}
)

func open(t *testing.T) *store.Store {
	t.Helper()
	s, err := store.Open(filepath.Join(t.TempDir(), "messages.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { s.Close() })
	return s
}

// send delivers a message and fails the test when it is refused.
func send(t *testing.T, s *store.Store, from, to gateway.Participant, thread int64, subject, body string) messages.Message {
	t.Helper()
	m, err := s.Send(context.Background(), from, to, thread, subject, body)
	if err != nil {
		t.Fatalf("Send(%s to %s, thread %d): %v", from.Name, to.Name, thread, err)
	}
	return m
}

func conversation(t *testing.T, s *store.Store, viewer gateway.Participant, thread int64) messages.Conversation {
	t.Helper()
	c, err := s.Conversation(context.Background(), viewer, thread, 0)
	if err != nil {
		t.Fatalf("Conversation(%s, thread %d): %v", viewer.Name, thread, err)
	}
	return c
}

func inbox(t *testing.T, s *store.Store, viewer gateway.Participant) []messages.Thread {
	t.Helper()
	threads, err := s.Inbox(context.Background(), viewer)
	if err != nil {
		t.Fatalf("Inbox(%s): %v", viewer.Name, err)
	}
	return threads
}

func threads(t *testing.T, s *store.Store) []messages.Thread {
	t.Helper()
	all, err := s.Threads(context.Background(), operator)
	if err != nil {
		t.Fatalf("Threads: %v", err)
	}
	return all
}

func ids(ts []messages.Thread) []int64 {
	out := []int64{}
	for _, th := range ts {
		out = append(out, th.ID)
	}
	return out
}

func bodies(c messages.Conversation) []string {
	out := []string{}
	for _, m := range c.Messages {
		out = append(out, m.Body)
	}
	return out
}

func TestSendStartsAThread(t *testing.T) {
	s := open(t)
	before := time.Now()
	m := send(t, s, alice, bob, 0, "", "hello bob")
	after := time.Now()

	if m.ID == 0 || m.Thread == 0 || m.From != "alice" || m.To != "bob" || m.Body != "hello bob" {
		t.Fatalf("Send returned %+v", m)
	}
	if m.Sent.Before(before.Add(-time.Second)) || m.Sent.After(after.Add(time.Second)) || m.Sent.Location() != time.UTC {
		t.Errorf("Sent = %v, want a UTC time between %v and %v", m.Sent, before, after)
	}

	all := threads(t, s)
	want := messages.Thread{ID: m.Thread, Subject: "hello bob", Participants: []string{"alice", "bob"}, Messages: 1, Unread: 0, Updated: m.Sent}
	if len(all) != 1 || !reflect.DeepEqual(all[0], want) {
		t.Fatalf("Threads = %+v, want [%+v]", all, want)
	}
}

func TestSubject(t *testing.T) {
	tests := []struct {
		name    string
		subject string
		body    string
		want    string
	}{
		{"explicit subject", "Deploy plan", "body text", "Deploy plan"},
		{"first line of the body", "", "first line\nsecond line", "first line"},
		{"blank subject", "  \t", "from the body", "from the body"},
		{"leading blank lines in the body", "", "\n\n  real first line  \nrest", "real first line"},
		{"windows line endings", "", "first\r\nsecond", "first"},
		{"explicit subject keeps its first line only", "one\ntwo", "body", "one"},
		{"long body line is cut to 80 runes", "", strings.Repeat("x", 100), strings.Repeat("x", 80)},
		{"long subject is cut to 80 runes", strings.Repeat("y", 200), "body", strings.Repeat("y", 80)},
		{"the cut counts runes", "", strings.Repeat("é", 100), strings.Repeat("é", 80)},
		{"80 runes stay whole", "", strings.Repeat("é", 80), strings.Repeat("é", 80)},
		{"a cut never splits a rune", "", strings.Repeat("日", 81), strings.Repeat("日", 80)},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			s := open(t)
			m := send(t, s, alice, bob, 0, tt.subject, tt.body)
			c := conversation(t, s, alice, m.Thread)
			if c.Thread.Subject != tt.want {
				t.Errorf("subject = %q, want %q", c.Thread.Subject, tt.want)
			}
		})
	}
}

func TestReplyKeepsTheSubjectAndThread(t *testing.T) {
	s := open(t)
	first := send(t, s, alice, bob, 0, "plan", "let us ship")
	reply := send(t, s, bob, alice, first.Thread, "ignored subject", "agreed")
	if reply.Thread != first.Thread {
		t.Fatalf("reply went to thread %d, want %d", reply.Thread, first.Thread)
	}
	if reply.ID <= first.ID {
		t.Errorf("message IDs %d then %d do not increase", first.ID, reply.ID)
	}

	c := conversation(t, s, alice, first.Thread)
	if got := bodies(c); !reflect.DeepEqual(got, []string{"let us ship", "agreed"}) {
		t.Errorf("messages = %q, want oldest first", got)
	}
	if c.Messages[0].From != "alice" || c.Messages[0].To != "bob" || c.Messages[1].From != "bob" || c.Messages[1].To != "alice" {
		t.Errorf("senders and recipients = %+v", c.Messages)
	}
	if c.Thread.Subject != "plan" || c.Thread.Messages != 2 || !reflect.DeepEqual(c.Thread.Participants, []string{"alice", "bob"}) {
		t.Errorf("thread = %+v", c.Thread)
	}
	if !c.Thread.Updated.Equal(reply.Sent) {
		t.Errorf("Updated = %v, want the latest message time %v", c.Thread.Updated, reply.Sent)
	}
}

func TestStrangerCannotWriteToAThread(t *testing.T) {
	s := open(t)
	m := send(t, s, alice, bob, 0, "", "private")
	_, err := s.Send(context.Background(), carol, alice, m.Thread, "", "let me in")
	if !errors.Is(err, fault.Forbidden) {
		t.Fatalf("Send by a stranger returned %v, want fault.Forbidden", err)
	}
	if c := conversation(t, s, alice, m.Thread); len(c.Messages) != 1 || len(c.Thread.Participants) != 2 {
		t.Errorf("the refused message left a trace: %+v", c)
	}
}

func TestStrangerCannotReadAThread(t *testing.T) {
	s := open(t)
	m := send(t, s, alice, bob, 0, "", "private")
	_, err := s.Conversation(context.Background(), carol, m.Thread, 0)
	if !errors.Is(err, fault.Forbidden) {
		t.Fatalf("Conversation by a stranger returned %v, want fault.Forbidden", err)
	}
	if got := inbox(t, s, bob); len(got) != 1 || got[0].Unread != 1 {
		t.Errorf("a refused read changed bob's inbox: %+v", got)
	}
}

func TestUnknownThread(t *testing.T) {
	s := open(t)
	send(t, s, alice, bob, 0, "", "hi")
	for _, thread := range []int64{999, -1} {
		if _, err := s.Send(context.Background(), alice, bob, thread, "", "hi"); !errors.Is(err, fault.NotFound) {
			t.Errorf("Send to thread %d returned %v, want fault.NotFound", thread, err)
		}
		if _, err := s.Conversation(context.Background(), operator, thread, 0); !errors.Is(err, fault.NotFound) {
			t.Errorf("Conversation of thread %d returned %v, want fault.NotFound", thread, err)
		}
	}
}

func TestRecipientJoinsTheThread(t *testing.T) {
	s := open(t)
	m := send(t, s, alice, bob, 0, "", "design review")
	// bob takes carol into the conversation by writing to her.
	send(t, s, bob, carol, m.Thread, "", "carol, your view?")

	c := conversation(t, s, carol, m.Thread)
	if want := []string{"alice", "bob", "carol"}; !reflect.DeepEqual(c.Thread.Participants, want) {
		t.Errorf("Participants = %q, want %q in join order", c.Thread.Participants, want)
	}
	if got := bodies(c); !reflect.DeepEqual(got, []string{"design review", "carol, your view?"}) {
		t.Errorf("carol reads %q, want the whole thread", got)
	}
	send(t, s, carol, alice, m.Thread, "", "looks fine")
	if c := conversation(t, s, alice, m.Thread); len(c.Thread.Participants) != 3 || c.Thread.Messages != 3 {
		t.Errorf("thread = %+v", c.Thread)
	}
}

func TestParticipantsJoinOnce(t *testing.T) {
	s := open(t)
	m := send(t, s, alice, bob, 0, "", "one")
	send(t, s, bob, alice, m.Thread, "", "two")
	send(t, s, alice, bob, m.Thread, "", "three")
	if c := conversation(t, s, bob, m.Thread); !reflect.DeepEqual(c.Thread.Participants, []string{"alice", "bob"}) {
		t.Errorf("Participants = %q", c.Thread.Participants)
	}
}

func TestInboxAndReadMarking(t *testing.T) {
	s := open(t)
	t1 := send(t, s, alice, bob, 0, "", "first to bob").Thread
	send(t, s, alice, bob, t1, "", "second to bob")
	t2 := send(t, s, carol, bob, 0, "", "carol to bob").Thread
	t3 := send(t, s, alice, carol, 0, "", "alice to carol").Thread

	got := inbox(t, s, bob)
	if !reflect.DeepEqual(ids(got), []int64{t2, t1}) {
		t.Fatalf("bob's inbox = %v, want threads %v, most recently updated first", ids(got), []int64{t2, t1})
	}
	if got[0].Unread != 1 || got[0].Messages != 1 || got[1].Unread != 2 || got[1].Messages != 2 {
		t.Errorf("bob's unread counts = %d of %d and %d of %d", got[0].Unread, got[0].Messages, got[1].Unread, got[1].Messages)
	}
	if again := inbox(t, s, bob); !reflect.DeepEqual(again, got) {
		t.Errorf("listing the inbox changed it: %+v then %+v", got, again)
	}
	if got := inbox(t, s, alice); len(got) != 0 {
		t.Errorf("alice sent everything and her inbox holds %+v", got)
	}
	if got := inbox(t, s, carol); !reflect.DeepEqual(ids(got), []int64{t3}) {
		t.Errorf("carol's inbox = %v, want [%d]", ids(got), t3)
	}

	// Reading marks what was unread, and the returned thread reports how much that was.
	c := conversation(t, s, bob, t1)
	if c.Thread.Unread != 2 {
		t.Errorf("reading reported %d unread, want 2", c.Thread.Unread)
	}
	if got := inbox(t, s, bob); !reflect.DeepEqual(ids(got), []int64{t2}) {
		t.Errorf("bob's inbox after reading thread %d = %v, want [%d]", t1, ids(got), t2)
	}
	if c := conversation(t, s, bob, t1); c.Thread.Unread != 0 {
		t.Errorf("reading again reported %d unread, want 0", c.Thread.Unread)
	}
}

func TestReadingMarksOnlyTheViewersMessages(t *testing.T) {
	s := open(t)
	m := send(t, s, alice, bob, 0, "", "to bob")
	send(t, s, bob, alice, m.Thread, "", "to alice")

	// alice reads the thread: her message from bob is read, bob's from alice stays unread.
	if c := conversation(t, s, alice, m.Thread); c.Thread.Unread != 1 {
		t.Errorf("alice's read reported %d unread, want 1", c.Thread.Unread)
	}
	got := inbox(t, s, bob)
	if len(got) != 1 || got[0].Unread != 1 {
		t.Fatalf("bob's inbox = %+v, want his one message still unread", got)
	}
	if got := inbox(t, s, alice); len(got) != 0 {
		t.Errorf("alice's inbox after reading = %+v", got)
	}
}

func TestSendingLeavesTheSendersMessagesRead(t *testing.T) {
	s := open(t)
	m := send(t, s, alice, bob, 0, "", "one")
	send(t, s, alice, bob, m.Thread, "", "two")
	if c := conversation(t, s, alice, m.Thread); c.Thread.Unread != 0 {
		t.Errorf("alice has %d unread in a thread she only wrote to", c.Thread.Unread)
	}
}

func TestThreadsOrderByLatestMessage(t *testing.T) {
	s := open(t)
	t1 := send(t, s, alice, bob, 0, "", "one").Thread
	t2 := send(t, s, alice, bob, 0, "", "two").Thread
	t3 := send(t, s, alice, bob, 0, "", "three").Thread
	if got := ids(threads(t, s)); !reflect.DeepEqual(got, []int64{t3, t2, t1}) {
		t.Fatalf("Threads = %v, want newest first %v", got, []int64{t3, t2, t1})
	}

	send(t, s, bob, alice, t1, "", "reply to the oldest")
	if got := ids(threads(t, s)); !reflect.DeepEqual(got, []int64{t1, t3, t2}) {
		t.Errorf("Threads after a reply in thread %d = %v, want %v", t1, got, []int64{t1, t3, t2})
	}
	if got := ids(inbox(t, s, alice)); !reflect.DeepEqual(got, []int64{t1}) {
		t.Errorf("alice's inbox = %v, want [%d]", got, t1)
	}
	if got := ids(inbox(t, s, bob)); !reflect.DeepEqual(got, []int64{t1, t3, t2}) {
		t.Errorf("bob's inbox = %v, want %v: a thread ranks by its latest message, whoever sent it", got, []int64{t1, t3, t2})
	}
}

func TestOperatorSeesEveryThread(t *testing.T) {
	s := open(t)
	t1 := send(t, s, alice, bob, 0, "", "between sessions").Thread
	t2 := send(t, s, bob, carol, 0, "", "also between sessions").Thread

	if got := ids(threads(t, s)); !reflect.DeepEqual(got, []int64{t2, t1}) {
		t.Fatalf("Threads = %v, want both threads", got)
	}
	if got := inbox(t, s, operator); len(got) != 0 {
		t.Errorf("the operator's inbox holds %+v, but nothing was sent to them", got)
	}
	c := conversation(t, s, operator, t1)
	if got := bodies(c); !reflect.DeepEqual(got, []string{"between sessions"}) {
		t.Errorf("the operator reads %q", got)
	}
	if c.Thread.Unread != 0 {
		t.Errorf("the operator has %d unread in a thread not addressed to them", c.Thread.Unread)
	}
	// Reading as the operator leaves the sessions' messages unread.
	if got := inbox(t, s, bob); len(got) != 1 || got[0].ID != t1 || got[0].Unread != 1 {
		t.Errorf("bob's inbox = %+v, want thread %d still unread", got, t1)
	}
}

func TestOperatorMessagesAndUnread(t *testing.T) {
	s := open(t)
	m := send(t, s, alice, operator, 0, "", "need a decision")
	all := threads(t, s)
	if len(all) != 1 || all[0].Unread != 1 || !reflect.DeepEqual(all[0].Participants, []string{"alice", "operator"}) {
		t.Fatalf("Threads = %+v, want one thread with one unread for the operator", all)
	}
	if got := ids(inbox(t, s, operator)); !reflect.DeepEqual(got, []int64{m.Thread}) {
		t.Errorf("the operator's inbox = %v", got)
	}
	if c := conversation(t, s, operator, m.Thread); c.Thread.Unread != 1 {
		t.Errorf("reading reported %d unread, want 1", c.Thread.Unread)
	}
	if all := threads(t, s); all[0].Unread != 0 {
		t.Errorf("the operator still has %d unread after reading", all[0].Unread)
	}
	if got := inbox(t, s, operator); len(got) != 0 {
		t.Errorf("the operator's inbox after reading = %+v", got)
	}
}

func TestOperatorMayWriteToAnyThread(t *testing.T) {
	s := open(t)
	m := send(t, s, alice, bob, 0, "", "between sessions")
	reply := send(t, s, operator, alice, m.Thread, "", "operator steps in")
	if reply.Thread != m.Thread || reply.From != "operator" || reply.To != "alice" {
		t.Fatalf("reply = %+v", reply)
	}
	c := conversation(t, s, bob, m.Thread)
	if want := []string{"alice", "bob", "operator"}; !reflect.DeepEqual(c.Thread.Participants, want) {
		t.Errorf("Participants = %q, want %q: the operator joins by writing", c.Thread.Participants, want)
	}
	if got := inbox(t, s, alice); len(got) != 1 || got[0].Unread != 1 {
		t.Errorf("alice's inbox = %+v, want the operator's message unread", got)
	}
}

func TestOnlyTheOperatorListsEveryThread(t *testing.T) {
	s := open(t)
	send(t, s, alice, bob, 0, "", "hi")
	for _, who := range []gateway.Participant{alice, bob, carol} {
		if _, err := s.Threads(context.Background(), who); !errors.Is(err, fault.Forbidden) {
			t.Errorf("Threads as %s returned %v, want fault.Forbidden", who.Name, err)
		}
	}
}

func TestBodyLimit(t *testing.T) {
	atLimit := strings.Repeat("x", messages.MaxBody)
	s := open(t)
	m := send(t, s, alice, bob, 0, "", atLimit)
	if c := conversation(t, s, bob, m.Thread); bodies(c)[0] != atLimit {
		t.Errorf("a body of %d bytes was stored as %d bytes", messages.MaxBody, len(bodies(c)[0]))
	}

	tests := []struct{ name, body string }{
		{"one byte over", atLimit + "x"},
		{"multibyte characters count their bytes", strings.Repeat("é", messages.MaxBody/2+1)},
		{"mostly blank", strings.Repeat(" ", messages.MaxBody) + "x"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if _, err := s.Send(context.Background(), alice, bob, 0, "", tt.body); !errors.Is(err, fault.Invalid) {
				t.Errorf("Send of %d bytes returned %v, want fault.Invalid", len(tt.body), err)
			}
			if _, err := s.Send(context.Background(), alice, bob, m.Thread, "", tt.body); !errors.Is(err, fault.Invalid) {
				t.Errorf("a reply of %d bytes returned %v, want fault.Invalid", len(tt.body), err)
			}
		})
	}
	if got := threads(t, s); len(got) != 1 || got[0].Messages != 1 {
		t.Errorf("refused bodies left %+v, want only the message at the limit", got)
	}
}

func TestSendRefusals(t *testing.T) {
	tests := []struct {
		name     string
		from, to gateway.Participant
		body     string
	}{
		{"empty body", alice, bob, ""},
		{"blank body", alice, bob, " \n\t "},
		{"to yourself", alice, alice, "note to self"},
		{"to yourself under another name", alice, gateway.Participant{ID: alice.ID, Name: "other"}, "hi"},
		{"operator to the operator", operator, operator, "hi"},
		{"no sender ID", gateway.Participant{Name: "alice"}, bob, "hi"},
		{"no sender name", gateway.Participant{ID: "id-alice"}, bob, "hi"},
		{"no recipient ID", alice, gateway.Participant{Name: "bob"}, "hi"},
		{"no recipient name", alice, gateway.Participant{ID: "id-bob"}, "hi"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			s := open(t)
			if _, err := s.Send(context.Background(), tt.from, tt.to, 0, "", tt.body); !errors.Is(err, fault.Invalid) {
				t.Fatalf("Send returned %v, want fault.Invalid", err)
			}
			if got := threads(t, s); len(got) != 0 {
				t.Errorf("the refused message left threads behind: %+v", got)
			}
		})
	}
}

func TestRefusedReplyLeavesNoMessage(t *testing.T) {
	s := open(t)
	m := send(t, s, alice, bob, 0, "", "hi")
	if _, err := s.Send(context.Background(), alice, alice, m.Thread, "", "to myself"); !errors.Is(err, fault.Invalid) {
		t.Fatalf("Send returned %v, want fault.Invalid", err)
	}
	if _, err := s.Send(context.Background(), alice, bob, m.Thread, "", "  "); !errors.Is(err, fault.Invalid) {
		t.Fatalf("Send returned %v, want fault.Invalid", err)
	}
	if c := conversation(t, s, alice, m.Thread); len(c.Messages) != 1 {
		t.Errorf("thread holds %d messages, want 1", len(c.Messages))
	}
}

func TestIdentityIsTheIDNotTheName(t *testing.T) {
	s := open(t)
	m := send(t, s, alice, bob, 0, "", "for the first alice")

	// A later session reusing the name has a new ID.
	successor := gateway.Participant{ID: "id-alice-2", Name: "alice"}
	if _, err := s.Conversation(context.Background(), successor, m.Thread, 0); !errors.Is(err, fault.Forbidden) {
		t.Errorf("Conversation by a session reusing a name returned %v, want fault.Forbidden", err)
	}
	if _, err := s.Send(context.Background(), successor, bob, m.Thread, "", "hi"); !errors.Is(err, fault.Forbidden) {
		t.Errorf("Send by a session reusing a name returned %v, want fault.Forbidden", err)
	}
	if got := inbox(t, s, successor); len(got) != 0 {
		t.Errorf("a session reusing a name inherited %+v", got)
	}
	// The two can message each other even though their names match.
	send(t, s, successor, alice, 0, "", "hello predecessor")
}

// Within a thread a name stands for one participant, so a reply to a later session holding an earlier one's name is a
// conflict.
func TestReplyToANameAnEarlierSessionHolds(t *testing.T) {
	s := open(t)
	m := send(t, s, alice, bob, 0, "", "for the first alice")
	successor := gateway.Participant{ID: "id-alice-2", Name: "alice"}

	for _, from := range []gateway.Participant{bob, operator} {
		if _, err := s.Send(context.Background(), from, successor, m.Thread, "", "who gets this?"); !errors.Is(err, fault.Conflict) {
			t.Errorf("a reply from %s to the later alice returned %v, want fault.Conflict", from.Name, err)
		}
	}
	if got := inbox(t, s, successor); len(got) != 0 {
		t.Errorf("the later alice's inbox = %+v, want empty", got)
	}

	send(t, s, bob, alice, m.Thread, "", "for the first alice again")
	send(t, s, bob, carol, m.Thread, "", "carol joins")
	send(t, s, bob, successor, 0, "", "a thread of their own")
	c := conversation(t, s, operator, m.Thread)
	if want := []string{"alice", "bob", "carol"}; !reflect.DeepEqual(c.Thread.Participants, want) || len(c.Messages) != 3 {
		t.Errorf("the first alice's thread = %+v, want participants %q and three messages", c, want)
	}
}

func TestEmptyListsAreNotNil(t *testing.T) {
	s := open(t)
	if got := inbox(t, s, alice); got == nil || len(got) != 0 {
		t.Errorf("Inbox = %#v, want an empty list", got)
	}
	if got := threads(t, s); got == nil || len(got) != 0 {
		t.Errorf("Threads = %#v, want an empty list", got)
	}
}

func TestMessagesSurviveReopening(t *testing.T) {
	path := filepath.Join(t.TempDir(), "messages.db")
	s, err := store.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	first := send(t, s, alice, bob, 0, "kept", "before the restart")
	if err := s.Close(); err != nil {
		t.Fatal(err)
	}

	s, err = store.Open(path)
	if err != nil {
		t.Fatalf("reopening: %v", err)
	}
	defer s.Close()
	c := conversation(t, s, bob, first.Thread)
	if c.Thread.Subject != "kept" || !reflect.DeepEqual(bodies(c), []string{"before the restart"}) || c.Thread.Unread != 1 {
		t.Errorf("after reopening: %+v", c)
	}
	next := send(t, s, bob, alice, first.Thread, "", "after the restart")
	if next.ID <= first.ID || next.Thread != first.Thread {
		t.Errorf("message %+v after reopening does not follow %+v", next, first)
	}
}

func TestOpenFailsWithoutADirectory(t *testing.T) {
	if _, err := store.Open(filepath.Join(t.TempDir(), "missing", "messages.db")); err == nil {
		t.Fatal("Open succeeded in a directory that does not exist")
	}
}

func TestCancelledContext(t *testing.T) {
	s := open(t)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := s.Send(ctx, alice, bob, 0, "", "hi"); !errors.Is(err, context.Canceled) {
		t.Fatalf("Send with a cancelled context returned %v, want context.Canceled", err)
	}
	if got := threads(t, s); len(got) != 0 {
		t.Errorf("the cancelled send left threads behind: %+v", got)
	}
}

func TestConcurrentSends(t *testing.T) {
	s := open(t)
	shared := send(t, s, alice, bob, 0, "", "shared thread").Thread

	const senders, each = 8, 15
	var wg sync.WaitGroup
	errs := make(chan error, senders*each*2)
	for i := range senders {
		wg.Add(1)
		go func() {
			defer wg.Done()
			from := gateway.Participant{ID: fmt.Sprintf("id-s%d", i), Name: fmt.Sprintf("s%d", i)}
			for j := range each {
				// Each pass writes to the shared thread as its participant (alice) and starts a thread of its own.
				if _, err := s.Send(context.Background(), alice, bob, shared, "", fmt.Sprintf("reply %d.%d", i, j)); err != nil {
					errs <- err
				}
				if _, err := s.Send(context.Background(), from, bob, 0, "", fmt.Sprintf("new %d.%d", i, j)); err != nil {
					errs <- err
				}
			}
		}()
	}
	wg.Wait()
	close(errs)
	for err := range errs {
		t.Errorf("concurrent Send: %v", err)
	}

	c := conversation(t, s, bob, shared)
	if want := 1 + senders*each; len(c.Messages) != want {
		t.Errorf("shared thread holds %d messages, want %d", len(c.Messages), want)
	}
	seen := map[int64]bool{}
	for _, m := range c.Messages {
		if seen[m.ID] {
			t.Fatalf("message ID %d appears twice", m.ID)
		}
		seen[m.ID] = true
	}
	if got, want := len(threads(t, s)), 1+senders*each; got != want {
		t.Errorf("%d threads, want %d", got, want)
	}
}

func TestConversationCarriesTheLatestMessagesWithinItsBudget(t *testing.T) {
	s := open(t)
	full := strings.Repeat("x", messages.MaxBody)
	first := send(t, s, alice, bob, 0, "big", "first")
	for range messages.MaxConversation/messages.MaxBody + 2 {
		send(t, s, alice, bob, first.Thread, "", full)
	}
	last := send(t, s, bob, alice, first.Thread, "", "last")
	c := conversation(t, s, alice, first.Thread)
	if got := c.Messages[len(c.Messages)-1].ID; got != last.ID {
		t.Fatalf("last message carried is %d, want the newest, %d", got, last.ID)
	}
	carried := 0
	for _, m := range c.Messages {
		carried += len(m.Body)
	}
	if carried > messages.MaxConversation || c.Earlier == 0 || c.Earlier+len(c.Messages) != c.Thread.Messages {
		t.Fatalf("carried %d body bytes in %d messages, %d earlier of %d", carried, len(c.Messages), c.Earlier, c.Thread.Messages)
	}

	lone := send(t, s, alice, bob, 0, "one", full)
	if c := conversation(t, s, bob, lone.Thread); len(c.Messages) != 1 || c.Earlier != 0 {
		t.Fatalf("a thread of one full message carried %d messages, %d earlier", len(c.Messages), c.Earlier)
	}
}

func TestConversationPagesPreserveUnreadMessages(t *testing.T) {
	s := open(t)
	body := strings.Repeat("x", messages.MaxBody)
	var sent []messages.Message
	var thread int64
	for range 10 {
		m := send(t, s, alice, bob, thread, "large thread", body)
		thread = m.Thread
		sent = append(sent, m)
	}
	var before int64
	seen := map[int64]bool{}
	for _, want := range []struct{ count, earlier, unread int }{{4, 6, 6}, {4, 2, 3}, {2, 0, 1}} {
		page, err := s.Conversation(context.Background(), bob, thread, before)
		if err != nil || len(page.Messages) != want.count || page.Earlier != want.earlier || page.Thread.Unread != want.count {
			t.Fatalf("page before %d: %d messages, %d earlier, %d marked read, err %v", before, len(page.Messages), page.Earlier, page.Thread.Unread, err)
		}
		for i, m := range page.Messages {
			if seen[m.ID] || (i > 0 && page.Messages[i-1].ID >= m.ID) {
				t.Fatalf("duplicate or unsorted message %d", m.ID)
			}
			seen[m.ID] = true
		}
		if box := inbox(t, s, bob); len(box) != 1 || box[0].Unread != want.unread {
			t.Fatalf("after reading a page: inbox %+v, want %d unread", box, want.unread)
		}
		before = page.Messages[0].ID
		if len(seen) == 4 {
			// A new reply while paging must remain unread until its own page is read.
			send(t, s, alice, bob, thread, "", "new reply")
		}
	}
	if len(seen) != len(sent) {
		t.Fatalf("read %d unique messages, want %d", len(seen), len(sent))
	}
	if page, err := s.Conversation(context.Background(), bob, thread, before); err != nil || len(page.Messages) != 0 || page.Earlier != 0 || page.Thread.Unread != 0 {
		t.Fatalf("before the first message: %+v, %v", page, err)
	}
	conversation(t, s, bob, thread)
	if box := inbox(t, s, bob); len(box) != 0 {
		t.Fatalf("new reply remains unread after latest page: %+v", box)
	}
}
