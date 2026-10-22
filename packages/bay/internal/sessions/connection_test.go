package sessions

import (
	"context"
	"io"
	"slices"
	"testing"
	"time"

	"github.com/gshpychka/realm/packages/bay/internal/fault"
)

func TestProgramConnectionStreamsIndependentlyOfProgram(t *testing.T) {
	svc, instances, _ := newService(t, 2)
	p := svc.config.Programs["agent"]
	p.Connect = []string{"worker", "connect", "a path", ""}
	svc.config.Programs["agent"] = p
	session := mustStart(t, svc, "one", StartSpec{Program: "agent"})
	if !session.Connectable {
		t.Fatal("configured bridge was not advertised")
	}
	c, err := svc.Connect(context.Background(), "one", session.ID)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { c.Close() })
	write := make(chan error, 1)
	go func() { _, err := io.WriteString(c, "hello\x00\n"); write <- err }()
	data := make([]byte, 7)
	if _, err := io.ReadFull(c, data); err != nil || string(data) != "hello\x00\n" {
		t.Fatalf("connection read %q, %v", data, err)
	}
	if err := <-write; err != nil {
		t.Fatal(err)
	}
	if _, err := svc.Connect(context.Background(), "one", session.ID); err == nil {
		t.Fatal("a second control connection was accepted")
	}
	c.Close()
	select {
	case <-c.(*programConnection).done:
	case <-time.After(2 * time.Second):
		t.Fatal("disconnect did not stop the bridge")
	}
	instances.mu.Lock()
	defer instances.mu.Unlock()
	inst := instances.instances["one"]
	if !inst.program || !inst.running {
		t.Fatal("disconnect stopped the persistent program")
	}
	want := []string{"bay-session", "connect", "--", "worker", "connect", "a path", ""}
	if got := inst.guest[len(inst.guest)-1]; !slices.Equal(got, want) {
		t.Fatalf("bridge argv = %q, want %q", got, want)
	}
}

func TestProgramConnectionPreconditions(t *testing.T) {
	svc, _, _ := newService(t, 2)
	p := svc.config.Programs["agent"]
	p.Connect = []string{"worker", "connect"}
	svc.config.Programs["agent"] = p
	session := mustStart(t, svc, "one", StartSpec{Program: "agent"})
	for _, test := range []struct {
		name, id string
		kind     error
	}{
		{"one", "", fault.Invalid},
		{"one", "stale", fault.Conflict},
		{"missing", session.ID, fault.NotFound},
	} {
		_, err := svc.Connect(context.Background(), test.name, test.id)
		wantKind(t, err, test.kind)
	}
	bare := mustStart(t, svc, "bare", StartSpec{Command: []string{"worker"}})
	if bare.Connectable {
		t.Fatal("bare command advertised a bridge")
	}
	_, err := svc.Connect(context.Background(), "bare", bare.ID)
	wantKind(t, err, fault.Conflict)
	if err := svc.Suspend(context.Background(), "one"); err != nil {
		t.Fatal(err)
	}
	_, err = svc.Connect(context.Background(), "one", session.ID)
	wantKind(t, err, fault.Conflict)
	if err := svc.Remove(context.Background(), "one"); err != nil {
		t.Fatal(err)
	}
	replacement := mustStart(t, svc, "one", StartSpec{Program: "agent"})
	if replacement.ID == session.ID {
		t.Fatal("removed session's identity was reused")
	}
	_, err = svc.Connect(context.Background(), "one", session.ID)
	wantKind(t, err, fault.Conflict)
}

func TestLifecycleClosesConnectionWithoutBlocking(t *testing.T) {
	for _, operation := range []string{"suspend", "remove"} {
		t.Run(operation, func(t *testing.T) {
			svc, _, _ := newService(t, 1)
			p := svc.config.Programs["agent"]
			p.Connect = []string{"worker", "connect"}
			svc.config.Programs["agent"] = p
			session := mustStart(t, svc, "one", StartSpec{Program: "agent"})
			c, err := svc.Connect(context.Background(), "one", session.ID)
			if err != nil {
				t.Fatal(err)
			}
			t.Cleanup(func() { c.Close() })
			finished := make(chan error, 1)
			go func() {
				if operation == "suspend" {
					finished <- svc.Suspend(context.Background(), "one")
				} else {
					finished <- svc.Remove(context.Background(), "one")
				}
			}()
			select {
			case err := <-finished:
				if err != nil {
					t.Fatal(err)
				}
			case <-time.After(2 * time.Second):
				t.Fatal("lifecycle change waited for operator input")
			}
			if _, err := c.Read(make([]byte, 1)); err == nil {
				t.Fatal("connection remained open after lifecycle change")
			}
		})
	}
}
