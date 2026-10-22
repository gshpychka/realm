package sessions

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"slices"
	"strings"
	"testing"

	"github.com/gshpychka/realm/packages/bay/internal/fault"
	"github.com/gshpychka/realm/packages/bay/internal/machines"
	"github.com/gshpychka/realm/packages/bay/internal/records"
)

func machineDefinition(revision string, memory int) machines.Definition {
	return machines.Definition{Base: machines.BasePrefix + revision, Revision: strings.Repeat(revision, 64), Resources: machines.Resources{CPUs: 1, Memory: memory, Disk: 6}}
}

func machineService(t *testing.T, budget int) (*Service, *fakeInstances, *records.Store) {
	t.Helper()
	svc, instances, store := newService(t, 4)
	svc.config.Machines = map[string]machines.Definition{machines.Default: machineDefinition("a", 4), "large": machineDefinition("b", 8)}
	svc.config.MaxMemory = budget
	p := svc.config.Programs["agent"]
	p.Machine = "large"
	p.Connect = []string{"old-worker", "connect"}
	p.MaxConnections = 2
	svc.config.Programs["agent"] = p
	return svc, instances, store
}

func TestSessionPinsMachineAndProgramAcrossCatalogChanges(t *testing.T) {
	ctx := context.Background()
	svc, instances, store := machineService(t, 16)
	first := mustStart(t, svc, "first", StartSpec{Program: "agent", MachineRevision: strings.Repeat("b", 64)})
	if first.Machine == nil || first.Machine.Name != "large" || first.Program.Runtime == nil {
		t.Fatalf("unpinned session: %+v", first)
	}
	if err := svc.End(ctx, "first", nil); err != nil {
		t.Fatal(err)
	}
	svc.config.Machines["large"] = machineDefinition("c", 2)
	p := svc.config.Programs["agent"]
	p.Command = []string{"new-worker"}
	p.Resume = []string{"new-worker", "resume"}
	p.Connect = []string{"new-worker", "connect"}
	svc.config.Programs["agent"] = p
	_, err := svc.Start(ctx, "stale", StartSpec{Program: "agent", MachineRevision: strings.Repeat("b", 64)})
	wantKind(t, err, fault.Conflict)
	if _, err := store.Get("stale"); !errors.Is(err, records.ErrNotFound) {
		t.Fatalf("failed precondition created a record: %v", err)
	}
	resumed, err := svc.Start(ctx, "first", StartSpec{MachineRevision: strings.Repeat("b", 64)})
	if err != nil {
		t.Fatal(err)
	}
	if resumed.Machine.Revision != first.Machine.Revision || instances.instances["first"].machine.Resources.Memory != 8 {
		t.Fatal("existing session followed the changed catalog")
	}
	launched := instances.instances["first"].guest
	if !slices.Equal(launched[len(launched)-1], []string{"bay-session", "launch", "quiet", "--", "agent"}) {
		t.Fatalf("used a replacement program: %q", launched)
	}
	if err := svc.End(ctx, "first", nil); err != nil {
		t.Fatal(err)
	}
	delete(svc.config.Programs, "agent")
	if _, err := svc.Start(ctx, "first", StartSpec{}); err != nil {
		t.Fatalf("pinned program was lost with its catalog entry: %v", err)
	}
}

func TestLegacyRecordPinsOnceWhenCatalogIsIntroduced(t *testing.T) {
	svc, _, store := newService(t, 2)
	mustStart(t, svc, "old", StartSpec{Program: "agent"})
	if err := svc.End(context.Background(), "old", nil); err != nil {
		t.Fatal(err)
	}
	svc.config.Machines = map[string]machines.Definition{machines.Default: machineDefinition("a", 4)}
	if _, err := svc.Start(context.Background(), "old", StartSpec{}); err != nil {
		t.Fatal(err)
	}
	record, err := store.Get("old")
	if err != nil || record.Machine == nil || record.Machine.Name != machines.Default || record.Program.Runtime == nil {
		t.Fatalf("legacy pin = %+v, %v", record, err)
	}
}

func TestMachineMemoryAdmissionUsesPinnedAndInFlightLimits(t *testing.T) {
	svc, instances, store := machineService(t, 12)
	held := instances.hold("large", "ready")
	started := make(chan error, 1)
	go func() {
		_, err := svc.Start(context.Background(), "large", StartSpec{Program: "agent"})
		started <- err
	}()
	<-held.arrived
	_, err := svc.Start(context.Background(), "too-large", StartSpec{Program: "agent"})
	wantKind(t, err, fault.Conflict)
	if _, err := store.Get("too-large"); !errors.Is(err, records.ErrNotFound) {
		t.Fatal("capacity failure left a record")
	}
	close(held.release)
	if err := <-started; err != nil {
		t.Fatal(err)
	}
	mustStart(t, svc, "small", StartSpec{})
	svc.config.Machines["large"] = machineDefinition("c", 1)
	_, err = svc.Start(context.Background(), "extra", StartSpec{Program: "agent"})
	wantKind(t, err, fault.Conflict)
	if err := svc.Suspend(context.Background(), "large"); err != nil {
		t.Fatal(err)
	}
	mustStart(t, svc, "extra", StartSpec{Program: "agent"})
	if err := svc.Resume(context.Background(), "large", "", nil); !errors.Is(err, fault.Conflict) {
		t.Fatalf("resume ignored pinned memory: %v", err)
	}
}

func TestMachineCatalogRejectsUndeclaredProgramAndBadDefinitions(t *testing.T) {
	store, err := records.Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	for _, config := range []Config{
		{MaxRunning: 1, Programs: map[string]Program{"p": {Command: []string{"p"}, Machine: "missing"}}},
		{MaxRunning: 1, Machines: map[string]machines.Definition{"other": machineDefinition("a", 1)}},
		{MaxRunning: 1, Machines: map[string]machines.Definition{machines.Default: {Base: "base", Revision: "mutable"}}},
	} {
		if _, err := New(store, newFakeInstances(), fakeRepos{}, config, slog.New(slog.NewTextHandler(io.Discard, nil))); err == nil {
			t.Fatalf("invalid catalog accepted: %+v", config)
		}
	}
}

func TestEndIdentityPreconditionLeavesReplacementRunning(t *testing.T) {
	svc, instances, _ := machineService(t, 16)
	first := mustStart(t, svc, "one", StartSpec{Program: "agent"})
	if err := svc.Remove(context.Background(), "one"); err != nil {
		t.Fatal(err)
	}
	replacement := mustStart(t, svc, "one", StartSpec{Program: "agent"})
	connection, err := svc.Connect(context.Background(), "one", replacement.ID)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { connection.Close() })
	err = svc.End(context.Background(), "one", nil, first.ID)
	wantKind(t, err, fault.Conflict)
	select {
	case <-connection.(*programConnection).done:
		t.Fatal("stale end disconnected the replacement's client")
	default:
	}
	if !instances.instances["one"].program {
		t.Fatal("stale end stopped the replacement")
	}
	if err := svc.End(context.Background(), "one", nil, replacement.ID); err != nil {
		t.Fatal(err)
	}
}

func TestSuspendIdentityPreconditionLeavesReplacementRunning(t *testing.T) {
	svc, instances, store := machineService(t, 16)
	first := mustStart(t, svc, "one", StartSpec{Program: "agent"})
	if err := svc.Remove(context.Background(), "one"); err != nil {
		t.Fatal(err)
	}
	replacement := mustStart(t, svc, "one", StartSpec{Program: "agent"})
	connection, err := svc.Connect(context.Background(), "one", replacement.ID)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { connection.Close() })
	wantKind(t, svc.Suspend(context.Background(), "one", first.ID), fault.Conflict)
	select {
	case <-connection.(*programConnection).done:
		t.Fatal("stale suspend disconnected the replacement's client")
	default:
	}
	if !instances.instances["one"].running || !instances.instances["one"].program {
		t.Fatal("stale suspend stopped the replacement")
	}
	if err := svc.Suspend(context.Background(), "one", replacement.ID); err != nil {
		t.Fatal(err)
	}
	select {
	case <-connection.(*programConnection).done:
	default:
		t.Fatal("suspend left a bridge open")
	}
	inst := instances.instances["one"]
	if inst.running || !inst.saved || !inst.program {
		t.Fatal("suspend did not preserve the replacement's instance state")
	}
	if record, err := store.Get("one"); err != nil || record.ID != replacement.ID {
		t.Fatalf("suspend lost the record: %+v, %v", record, err)
	}
}
