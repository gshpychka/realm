package sessions

import (
	"context"
	"io"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/gshpychka/realm/packages/bay/internal/identity"
)

// Cancellation requests cleanup; returning from Connect acknowledges that the
// guest bridge and its commands have actually stopped. Keep those events apart.
type unacknowledgedBridgeInstances struct {
	*fakeInstances
	entered      chan struct{}
	cancelled    chan struct{}
	release      chan struct{}
	suspendCalls atomic.Int32
}

func (f *unacknowledgedBridgeInstances) Connect(ctx context.Context, name, sessionID string, argv []string, _ io.Reader, _ io.Writer) error {
	if err := f.Exec(ctx, name, argv, nil, io.Discard); err != nil {
		return err
	}
	close(f.entered)
	<-ctx.Done()
	close(f.cancelled)
	<-f.release
	return ctx.Err()
}

func (f *unacknowledgedBridgeInstances) Suspend(ctx context.Context, name string) error {
	f.suspendCalls.Add(1)
	return f.fakeInstances.Suspend(ctx, name)
}

func TestSuspendRequiresBridgeExitAcknowledgement(t *testing.T) {
	svc, instances, _ := newService(t, 1)
	svc.bridgeCloseTimeout = 30 * time.Millisecond
	session := mustStart(t, svc, "one", StartSpec{Program: "agent"})
	expected := identity.Precondition{ID: session.ID, Generation: &session.Generation}
	blocked := &unacknowledgedBridgeInstances{
		fakeInstances: instances,
		entered:       make(chan struct{}),
		cancelled:     make(chan struct{}),
		release:       make(chan struct{}),
	}
	svc.instances = blocked
	var releaseOnce sync.Once
	release := func() { releaseOnce.Do(func() { close(blocked.release) }) }
	t.Cleanup(release)

	bridge, err := svc.Environment(context.Background(), "one", expected, session.Machine.Revision)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { bridge.Close() })
	connection := bridge.(*environmentConnection)
	select {
	case <-blocked.entered:
	case <-time.After(time.Second):
		t.Fatal("guest bridge did not start")
	}

	// A failed attempt must leave the unacknowledged bridge registered,
	// so a retry cannot bypass the same lifetime boundary.
	for attempt := range 2 {
		finished := make(chan error, 1)
		go func() { finished <- svc.Suspend(context.Background(), "one", expected) }()
		select {
		case err := <-finished:
			if err == nil {
				t.Fatalf("suspend attempt %d accepted cancellation as an exit acknowledgement", attempt+1)
			}
		case <-time.After(time.Second):
			t.Fatal("suspend did not bound its wait for the guest bridge")
		}
		select {
		case <-blocked.cancelled:
		case <-time.After(time.Second):
			t.Fatal("suspend did not request guest bridge cancellation")
		}
		select {
		case <-connection.done:
			t.Fatal("bridge completion preceded the guest acknowledgement")
		default:
		}
		svc.mu.Lock()
		_, retained := svc.connections["one"][connection]
		svc.mu.Unlock()
		if !retained {
			t.Fatal("timed out bridge was removed before its guest acknowledged exit")
		}
		if calls := blocked.suspendCalls.Load(); calls != 0 {
			t.Fatalf("suspend touched the VM %d times before bridge cleanup completed", calls)
		}
		instances.mu.Lock()
		instance := instances.instances["one"]
		running, saved, programRunning := instance.running, instance.saved, instance.program
		instances.mu.Unlock()
		if !running || saved || !programRunning {
			t.Fatal("failed bridge cleanup changed the running VM or persistent program")
		}
	}

	release()
	select {
	case <-connection.done:
	case <-time.After(time.Second):
		t.Fatal("guest exit acknowledgement did not complete the bridge")
	}
	if err := svc.Suspend(context.Background(), "one", expected); err != nil {
		t.Fatalf("suspend did not recover after the guest acknowledged exit: %v", err)
	}
	if calls := blocked.suspendCalls.Load(); calls != 1 {
		t.Fatalf("suspend called the VM %d times, want exactly one after cleanup", calls)
	}
	instances.mu.Lock()
	running, saved := instances.instances["one"].running, instances.instances["one"].saved
	instances.mu.Unlock()
	if running || !saved {
		t.Fatal("acknowledged bridge cleanup did not permit VM suspension")
	}
}
