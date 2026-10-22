package store_test

import (
	"context"
	"errors"
	"path/filepath"
	"reflect"
	"strings"
	"sync"
	"testing"

	"github.com/gshpychka/realm/packages/bay/internal/fault"
	"github.com/gshpychka/realm/packages/bay/internal/gateway"
	"github.com/gshpychka/realm/packages/bay/internal/gateway/store"
	"github.com/gshpychka/realm/packages/bay/internal/messages"
)

func TestFeedPaginatesForwardWithoutMarkingMailRead(t *testing.T) {
	s := open(t)
	from := alice
	from.Generation = 7
	var wanted []int64
	for i := 0; i < 9; i++ {
		m := send(t, s, from, operator, 0, "", strings.Repeat("x", messages.MaxBody))
		wanted = append(wanted, m.ID)
	}
	other := send(t, s, bob, carol, 0, "", "peer mail")
	wanted = append(wanted, other.ID)
	beforeOperator, beforeCarol := inbox(t, s, operator), inbox(t, s, carol)
	var got []int64
	after := ""
	for {
		page, err := s.Feed(context.Background(), operator, after)
		if err != nil {
			t.Fatal(err)
		}
		if len(page.Messages) == 0 || page.Next == after {
			t.Fatalf("feed made no progress: %+v", page)
		}
		budget := 0
		for _, m := range page.Messages {
			got = append(got, m.ID)
			budget += len(m.Body)
			if m.ID != other.ID && (m.FromID != from.ID || m.ToID != operator.ID || m.FromGeneration != 7) {
				t.Fatalf("lost provenance: %+v", m)
			}
		}
		if budget > messages.MaxConversation {
			t.Fatal("feed exceeded its body budget")
		}
		after = page.Next
		if !page.More {
			break
		}
	}
	if !reflect.DeepEqual(got, wanted) {
		t.Fatalf("feed IDs = %v, want %v", got, wanted)
	}
	if !reflect.DeepEqual(inbox(t, s, operator), beforeOperator) || !reflect.DeepEqual(inbox(t, s, carol), beforeCarol) {
		t.Fatal("observation changed unread mail")
	}
	empty, err := s.Feed(context.Background(), operator, after)
	if err != nil || len(empty.Messages) != 0 || empty.More || empty.Next != after {
		t.Fatalf("empty page = %+v, %v", empty, err)
	}
	if _, err := s.Feed(context.Background(), bob, ""); !errors.Is(err, fault.Forbidden) {
		t.Fatalf("guest feed = %v", err)
	}
}

func TestFeedCursorSurvivesRestartAndRejectsOtherDatabases(t *testing.T) {
	path := filepath.Join(t.TempDir(), "messages.db")
	s, err := store.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	m := send(t, s, alice, bob, 0, "", "first")
	page, err := s.Feed(context.Background(), operator, "")
	if err != nil {
		t.Fatal(err)
	}
	if err := s.Close(); err != nil {
		t.Fatal(err)
	}
	s, err = store.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	next := send(t, s, bob, alice, m.Thread, "", "after restart")
	page, err = s.Feed(context.Background(), operator, page.Next)
	if err != nil || len(page.Messages) != 1 || page.Messages[0].ID != next.ID {
		t.Fatalf("restart feed = %+v, %v", page, err)
	}
	if _, err := open(t).Feed(context.Background(), operator, page.Next); !errors.Is(err, fault.Conflict) {
		t.Fatalf("foreign cursor = %v", err)
	}
	if _, err := s.Feed(context.Background(), operator, "not:a:cursor"); !errors.Is(err, fault.Invalid) {
		t.Fatalf("invalid cursor = %v", err)
	}
}

func TestFeedBoundsMessageCountAsWellAsBodyBytes(t *testing.T) {
	s := open(t)
	for i := 0; i < 130; i++ {
		send(t, s, alice, bob, 0, "", "x")
	}
	first, err := s.Feed(context.Background(), operator, "")
	if err != nil || len(first.Messages) != 128 || !first.More {
		t.Fatalf("first count page = %+v, %v", first, err)
	}
	second, err := s.Feed(context.Background(), operator, first.Next)
	if err != nil || len(second.Messages) != 2 || second.More || second.Messages[0].ID <= first.Messages[127].ID {
		t.Fatalf("second count page = %+v, %v", second, err)
	}
}

func TestConcurrentDeliveryKeepsOneThreadAndReceipt(t *testing.T) {
	s := open(t)
	input := messages.Send{To: bob.Name, ToID: bob.ID, ClientID: "logical-send", Body: "exactly one stored message"}
	const count = 12
	var wait sync.WaitGroup
	results := make(chan gateway.Delivery, count)
	failures := make(chan error, count)
	for i := 0; i < count; i++ {
		wait.Go(func() {
			delivery, err := s.Deliver(context.Background(), alice, bob, input)
			results <- delivery
			failures <- err
		})
	}
	wait.Wait()
	close(results)
	close(failures)
	for err := range failures {
		if err != nil {
			t.Fatal(err)
		}
	}
	var id int64
	created := 0
	for result := range results {
		if id == 0 {
			id = result.Message.ID
		}
		if id != result.Message.ID {
			t.Fatal("retry produced another message")
		}
		if result.Created {
			created++
		}
	}
	if created != 1 || len(threads(t, s)) != 1 {
		t.Fatal("retry produced another thread or effect")
	}
	input.Body = "changed"
	if _, err := s.Deliver(context.Background(), alice, bob, input); !errors.Is(err, fault.Conflict) {
		t.Fatalf("changed request = %v", err)
	}
	input.Body = "exactly one stored message"
	successor := alice
	successor.ID = "replacement-alice"
	if result, err := s.Deliver(context.Background(), successor, bob, input); err != nil || !result.Created || result.Message.ID == id {
		t.Fatalf("successor inherited receipt: %+v, %v", result, err)
	}
}
