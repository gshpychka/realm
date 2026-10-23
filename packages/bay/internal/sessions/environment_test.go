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
	connections := make([]*environmentConnection, 4)
	for i := range connections {
		c, err := svc.Environment(context.Background(), "one", expected, session.Machine.Revision)
		if err != nil {
			t.Fatal(err)
		}
		connections[i] = c.(*environmentConnection)
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

func TestRejectedLifecycleRequestsPreserveEnvironment(t *testing.T) {
	ctx := context.Background()
	svc, _, _ := machineService(t, 16)
	session := mustStart(t, svc, "one", StartSpec{Program: "agent"})
	for _, name := range []string{"first", "second"} {
		if _, err := svc.Snap(ctx, "one", name); err != nil {
			t.Fatal(err)
		}
	}
	expected := identity.Precondition{ID: session.ID, Generation: &session.Generation}
	connection, err := svc.Environment(ctx, "one", expected, session.Machine.Revision)
	if err != nil {
		t.Fatal(err)
	}
	defer connection.Close()
	for name, operation := range map[string]func() error{
		"start running":                          func() error { _, err := svc.Start(ctx, "one", StartSpec{}); return err },
		"start existing with program":            func() error { _, err := svc.Start(ctx, "one", StartSpec{Program: "agent"}); return err },
		"resume running":                         func() error { return svc.Resume(ctx, "one", "", nil) },
		"resume missing snapshot":                func() error { return svc.Resume(ctx, "one", "missing", nil) },
		"resume without discard acknowledgement": func() error { return svc.Resume(ctx, "one", "first", nil) },
		"snapshot invalid name":                  func() error { _, err := svc.Snap(ctx, "one", "bad/name"); return err },
		"snapshot duplicate":                     func() error { _, err := svc.Snap(ctx, "one", "first"); return err },
		"end without snapshot acknowledgement":   func() error { return svc.End(ctx, "one", nil) },
	} {
		t.Run(name, func(t *testing.T) {
			if err := operation(); err == nil {
				t.Fatal("invalid lifecycle request succeeded")
			}
			select {
			case <-connection.(*environmentConnection).done:
				t.Fatal("rejected lifecycle request disconnected the environment")
			default:
			}
		})
	}
}
