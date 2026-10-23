package sessions

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"strings"
	"testing"

	"github.com/gshpychka/realm/packages/bay/internal/fault"
	"github.com/gshpychka/realm/packages/bay/internal/guest"
	"github.com/gshpychka/realm/packages/bay/internal/identity"
	"github.com/gshpychka/realm/packages/bay/internal/operations"
	"github.com/gshpychka/realm/packages/bay/internal/records"
)

func TestOperatorOperationsFenceRecordGenerationAndCommandMachineBeforeGuestAccess(t *testing.T) {
	svc, instances, _ := machineService(t, 16)
	session := mustStart(t, svc, "one", StartSpec{Program: "agent"})
	before := len(instances.instances["one"].guest)
	stale := session.Generation - 1
	for _, expected := range []identity.Precondition{{ID: "other", Generation: &session.Generation}, {ID: session.ID, Generation: &stale}} {
		if _, err := svc.PutBlob(context.Background(), "one", expected, strings.Repeat("a", 64), strings.NewReader("bytes")); !errors.Is(err, fault.Conflict) {
			t.Fatalf("stale upload = %v", err)
		}
		if _, err := svc.Capture(context.Background(), "one", expected, "capture", operations.Capture{Path: "file", MaxBytes: 64}); !errors.Is(err, fault.Conflict) {
			t.Fatalf("stale capture = %v", err)
		}
		if _, _, err := svc.ReadCapture(context.Background(), "one", expected, "capture"); !errors.Is(err, fault.Conflict) {
			t.Fatalf("stale download = %v", err)
		}
		if _, err := svc.Job(context.Background(), "one", expected, "job"); !errors.Is(err, fault.Conflict) {
			t.Fatalf("stale job lookup = %v", err)
		}
	}
	request := operations.Command{Argv: []string{"true"}, Cwd: ".", TimeoutMS: 1000, MaxOutputBytes: 1024, MachineRevision: strings.Repeat("a", 64)}
	if _, err := svc.StartJob(context.Background(), "one", identity.Precondition{ID: session.ID, Generation: &session.Generation}, "job", request); !errors.Is(err, fault.Conflict) {
		t.Fatalf("changed machine = %v", err)
	}
	if got := len(instances.instances["one"].guest); got != before {
		t.Fatalf("fenced operation reached guest: %d calls became %d", before, got)
	}
}

func TestFailedDetachedCommandRemainsAJobNotATransportFailure(t *testing.T) {
	g := guest.New(func(_ context.Context, _ []string, _ io.Reader, w io.Writer) error {
		return json.NewEncoder(w).Encode(operations.Job{ID: "timeout", Status: operations.TimedOut, Error: "command exceeded its timeout"})
	})
	var job operations.Job
	if err := operatorJSON(context.Background(), g, records.Record{ID: "record", Generation: 1}, "job", "timeout", nil, &job); err != nil {
		t.Fatal(err)
	}
	if job.Status != operations.TimedOut || job.Error != "command exceeded its timeout" {
		t.Fatalf("failed command receipt = %+v", job)
	}
}
