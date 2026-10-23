package store_test

import (
	"context"
	"errors"
	"sync"
	"testing"

	"github.com/gshpychka/realm/packages/bay/internal/fault"
	"github.com/gshpychka/realm/packages/bay/internal/gateway"
	"github.com/gshpychka/realm/packages/bay/internal/messages"
)

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
