package sessions

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/gshpychka/realm/packages/bay/internal/fault"
	"github.com/gshpychka/realm/packages/bay/internal/identity"
)

func TestEnvironmentRequiresExactExecutionAndLifecycleClosesEveryConnection(t *testing.T) {
	svc, _, _ := machineService(t, 16)
	session := mustStart(t, svc, "one", StartSpec{Program: "agent"})
	expected := identity.Precondition{ID: session.ID, Generation: &session.Generation}
	old := session.Generation - 1
	for _, test := range []struct {
		expected identity.Precondition
		revision string
	}{{identity.Precondition{ID: "reused", Generation: &session.Generation}, session.Machine.Revision}, {identity.Precondition{ID: session.ID, Generation: &old}, session.Machine.Revision}, {expected, "other"}} {
		if c, err := svc.Environment(context.Background(), "one", test.expected, test.revision); !errors.Is(err, fault.Conflict) {
			if c != nil {
				c.Close()
			}
			t.Fatalf("stale environment accepted: %v", err)
		}
	}
	connections := make([]*programConnection, 4)
	for i := range connections {
		c, err := svc.Environment(context.Background(), "one", expected, session.Machine.Revision)
		if err != nil {
			t.Fatal(err)
		}
		connections[i] = c.(*programConnection)
	}
	if c, err := svc.Environment(context.Background(), "one", expected, session.Machine.Revision); !errors.Is(err, fault.Conflict) {
		if c != nil {
			c.Close()
		}
		t.Fatalf("environment limit ignored: %v", err)
	}
	if err := svc.Suspend(context.Background(), "one", expected); err != nil {
		t.Fatal(err)
	}
	for _, c := range connections {
		select {
		case <-c.done:
		case <-time.After(time.Second):
			t.Fatal("suspend left environment connection alive")
		}
	}
}
