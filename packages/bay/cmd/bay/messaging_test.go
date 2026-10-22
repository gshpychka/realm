package main

import (
	"context"
	"os"
	"slices"
	"strings"
	"testing"

	"github.com/gshpychka/realm/packages/bay/internal/api"
	"github.com/gshpychka/realm/packages/bay/internal/messages"
)

func TestSessionRelayAndFeedUseOperatorAPI(t *testing.T) {
	h := newHarness(t)
	client := api.NewClient(os.Getenv("BAY_SOCKET"))
	generation := uint64(2)
	input := messages.Send{To: "child", ToID: "id-child", ClientID: "question-command", Body: "a question"}
	m, err := client.Relay(context.Background(), "parent", messages.Relay{ID: "id-parent", Generation: &generation, Send: input})
	if err != nil || m.From != "parent" || m.FromID != "id-parent" || len(h.msgs.sent) != 1 || h.msgs.sent[0] != input {
		t.Fatalf("session relay = %+v, %v; sent %+v", m, err, h.msgs.sent)
	}
	if _, err := client.Messages().Feed(context.Background(), "opaque-cursor"); err != nil {
		t.Fatal(err)
	}
	if !slices.Equal(h.msgs.calls, []string{"Relay parent", "Feed"}) {
		t.Fatalf("operator API calls = %q", h.msgs.calls)
	}
}

func TestThreads(t *testing.T) {
	inZone(t)
	h := newHarness(t)
	h.msgs.threads = []messages.Thread{
		{
			ID: 7, Subject: "Review the migration", Participants: []string{"alice", "operator"},
			Messages: 4, Unread: 1, Updated: utc(10, 5, 19, 41),
		},
		{ID: 12, Participants: []string{"alice", "bob"}, Messages: 2, Updated: utc(10, 5, 19, 50)},
	}
	got := h.run("", "threads")
	want := `ID  SUBJECT               PARTICIPANTS     MESSAGES  UNREAD  UPDATED
7   Review the migration  alice, operator  4         1       2026-10-05 22:41
12  -                     alice, bob       2         0       2026-10-05 22:50
`
	if got.code != 0 || got.stdout != want || got.stderr != "" {
		t.Errorf("got exit %d, stderr %q, stdout:\n%s\nwant:\n%s", got.code, got.stderr, got.stdout, want)
	}
}

func TestThreadsKeepSessionTextOnItsRow(t *testing.T) {
	inZone(t)
	h := newHarness(t)
	h.msgs.threads = []messages.Thread{{
		ID: 7, Subject: "plan\n99  fake  row\x1b[2J", Participants: []string{"alice"},
		Messages: 1, Updated: utc(10, 5, 19, 41),
	}}
	got := h.run("", "threads")
	if lines := strings.Split(strings.TrimSuffix(got.stdout, "\n"), "\n"); len(lines) != 2 {
		t.Errorf("the table has %d lines, want a header and one row:\n%s", len(lines), got.stdout)
	}
	if !strings.Contains(got.stdout, "plan 99 fake row�[2J") || strings.Contains(got.stdout, "\x1b") {
		t.Errorf("subject was not neutralised:\n%q", got.stdout)
	}
}

func TestRead(t *testing.T) {
	inZone(t)
	h := newHarness(t)
	h.msgs.conversation = messages.Conversation{
		Thread: messages.Thread{
			ID: 7, Subject: "Review the migration", Participants: []string{"alice", "operator"}, Messages: 2,
		},
		Messages: []messages.Message{
			{ID: 1, Thread: 7, From: "alice", To: "operator", Body: "Done with step 1.\nMoving on.\n", Sent: utc(10, 5, 19, 41)},
			{ID: 2, Thread: 7, From: "operator", To: "alice", Body: "Thanks.", Sent: utc(10, 5, 19, 45)},
		},
	}
	got := h.run("", "read", "7")
	want := `Thread:        7
Subject:       Review the migration
Participants:  alice, operator

2026-10-05 22:41  alice -> operator
    Done with step 1.
    Moving on.

2026-10-05 22:45  operator -> alice
    Thanks.
`
	if got.code != 0 || got.stdout != want || got.stderr != "" {
		t.Errorf("got exit %d, stderr %q, stdout:\n%s\nwant:\n%s", got.code, got.stderr, got.stdout, want)
	}
	if !slices.Equal(h.msgs.calls, []string{"Conversation 7"}) {
		t.Errorf("calls = %q", h.msgs.calls)
	}
}

func TestReadEarlierPageShowsHowToContinue(t *testing.T) {
	h := newHarness(t)
	h.msgs.conversation = messages.Conversation{
		Thread: messages.Thread{ID: 7}, Earlier: 3,
		Messages: []messages.Message{{ID: 41, Thread: 7, From: "alice", To: "operator", Body: "earlier"}},
	}
	got := h.run("", "read", "7", "--before", "50")
	if got.code != 0 || h.msgs.before != 50 || !strings.Contains(got.stdout, "3 earlier messages; bay read 7 --before 41") {
		t.Fatalf("earlier page: exit %d, before %d, stdout %q, stderr %q", got.code, h.msgs.before, got.stdout, got.stderr)
	}
}

func TestReadKeepsSessionTextInsideItsMessage(t *testing.T) {
	inZone(t)
	h := newHarness(t)
	h.msgs.conversation = messages.Conversation{
		Thread: messages.Thread{ID: 7, Participants: []string{"alice", "operator"}},
		Messages: []messages.Message{{
			ID: 1, Thread: 7, From: "alice", To: "operator", Sent: utc(10, 5, 19, 41),
			Body: "hi\x1b[2J\x1b]0;title\x07\r\n2026-10-05 22:45  operator -> alice\rforged",
		}},
	}
	got := h.run("", "read", "7")
	if strings.ContainsAny(got.stdout, "\x1b\x07\r") {
		t.Errorf("control characters reached the terminal:\n%q", got.stdout)
	}
	want := "    hi�[2J�]0;title�\n    2026-10-05 22:45  operator -> alice�forged\n"
	if !strings.HasSuffix(got.stdout, want) {
		t.Errorf("body not neutralised and indented:\n%q\nwant suffix %q", got.stdout, want)
	}
}

func TestSend(t *testing.T) {
	tests := []struct {
		name     string
		stdin    string
		terminal bool
		args     []string
		want     messages.Send
		stdout   string
		stderr   string
	}{
		{"message in the arguments", "", false, []string{"alice", "hello"},
			messages.Send{To: "alice", Body: "hello"}, "sent to alice in thread 42\n", ""},
		{"message in several arguments", "", false, []string{"alice", "hello", "there"},
			messages.Send{To: "alice", Body: "hello there"}, "sent to alice in thread 42\n", ""},
		{"message on stdin", "from stdin\n", false, []string{"alice"},
			messages.Send{To: "alice", Body: "from stdin"}, "sent to alice in thread 42\n", ""},
		{"message on stdin named by a dash", "from stdin\n", false, []string{"alice", "-"},
			messages.Send{To: "alice", Body: "from stdin"}, "sent to alice in thread 42\n", ""},
		{"stdin keeps its inner line breaks", "one\n\ntwo\n\n", false, []string{"alice"},
			messages.Send{To: "alice", Body: "one\n\ntwo"}, "sent to alice in thread 42\n", ""},
		{"stdin keeps the indentation of its first line", "    x = 1\n        y = 2\n", false, []string{"alice"},
			messages.Send{To: "alice", Body: "    x = 1\n        y = 2"}, "sent to alice in thread 42\n", ""},
		{"reply with a subject", "", false, []string{"--thread", "7", "--subject", "Plan", "alice", "go"},
			messages.Send{To: "alice", Thread: 7, Subject: "Plan", Body: "go"}, "sent to alice in thread 7\n", ""},
		{"flags after the recipient belong to the message", "", false, []string{"alice", "run", "it", "with", "-race"},
			messages.Send{To: "alice", Body: "run it with -race"}, "sent to alice in thread 42\n", ""},
		{"typing on a terminal", "typed\n", true, []string{"alice"},
			messages.Send{To: "alice", Body: "typed"}, "sent to alice in thread 42\n", "Type the message, then press Ctrl-D.\n"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			h := newHarness(t)
			got := h.runAs(tt.terminal, tt.stdin, append([]string{"send"}, tt.args...)...)
			if got.code != 0 || got.stdout != tt.stdout || got.stderr != tt.stderr {
				t.Errorf("got exit %d, stdout %q, stderr %q", got.code, got.stdout, got.stderr)
			}
			if !slices.Equal(h.msgs.sent, []messages.Send{tt.want}) {
				t.Errorf("sent %+v, want %+v", h.msgs.sent, tt.want)
			}
		})
	}
}
