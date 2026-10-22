package sessions

import (
	"context"
	"testing"

	"github.com/gshpychka/realm/packages/bay/internal/fault"
	"github.com/gshpychka/realm/packages/bay/internal/identity"
)

func TestExecutionGenerationFencesLifecycleAndConnections(t *testing.T) {
	ctx := context.Background()
	svc, _, store := machineService(t, 16)
	first := mustStart(t, svc, "one", StartSpec{Program: "agent"})
	if first.Generation != 1 {
		t.Fatalf("first generation = %d", first.Generation)
	}
	if _, err := svc.Snap(ctx, "one", "initial"); err != nil {
		t.Fatal(err)
	}
	if err := svc.Suspend(ctx, "one"); err != nil {
		t.Fatal(err)
	}
	if err := svc.Resume(ctx, "one", "", nil); err != nil {
		t.Fatal(err)
	}
	current, err := svc.Get(ctx, "one")
	if err != nil || current.Generation != 2 {
		t.Fatalf("resumed session = %+v, %v", current, err)
	}
	if _, err := svc.Connect(ctx, "one", first.ID, first.Generation); err == nil {
		t.Fatal("stale execution connected")
	}
	connection, err := svc.Connect(ctx, "one", current.ID, current.Generation)
	if err != nil {
		t.Fatal(err)
	}
	defer connection.Close()
	stale := identity.Precondition{ID: first.ID, Generation: &first.Generation}
	operations := map[string]func() error{
		"suspend": func() error { return svc.Suspend(ctx, "one", stale) },
		"resume":  func() error { return svc.Resume(ctx, "one", "initial", nil, stale) },
		"end":     func() error { return svc.End(ctx, "one", []string{"initial"}, stale) },
		"remove":  func() error { return svc.Remove(ctx, "one", stale) },
		"snap":    func() error { _, err := svc.Snap(ctx, "one", "later", stale); return err },
		"start":   func() error { _, err := svc.Start(ctx, "one", StartSpec{Expected: stale}); return err },
	}
	for name, operation := range operations {
		t.Run(name, func(t *testing.T) {
			wantKind(t, operation(), fault.Conflict)
			select {
			case <-connection.(*programConnection).done:
				t.Fatal("stale lifecycle call disconnected current execution")
			default:
			}
		})
	}
	if rec, err := store.Get("one"); err != nil || rec.Generation != 2 {
		t.Fatalf("stale calls changed generation: %+v, %v", rec, err)
	}
}

func TestRollbackPersistsGenerationBeforeTouchingGuest(t *testing.T) {
	ctx := context.Background()
	svc, instances, store := newService(t, 2)
	first := mustStart(t, svc, "one", StartSpec{})
	if _, err := svc.Snap(ctx, "one", "initial"); err != nil {
		t.Fatal(err)
	}
	gate := instances.hold("one", "restore")
	restored := make(chan error, 1)
	go func() { restored <- svc.Resume(ctx, "one", "initial", nil) }()
	<-gate.arrived
	rec, err := store.Get("one")
	if err != nil || rec.Generation != first.Generation+1 {
		t.Errorf("generation before restore = %+v, %v", rec, err)
	}
	close(gate.release)
	if err := <-restored; err != nil {
		t.Fatal(err)
	}
	if err := svc.End(ctx, "one", []string{"initial"}); err != nil {
		t.Fatal(err)
	}
	again := mustStart(t, svc, "one", StartSpec{})
	if again.ID != first.ID || again.Generation != first.Generation+2 {
		t.Fatalf("fresh instance reused execution authority: %+v", again)
	}
}
