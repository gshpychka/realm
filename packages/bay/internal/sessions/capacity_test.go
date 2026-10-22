package sessions

import (
	"context"
	"errors"
	"testing"

	"github.com/gshpychka/realm/packages/bay/internal/fault"
	"github.com/gshpychka/realm/packages/bay/internal/records"
)

func TestAdmissionRefusalIsDefiniteAndCreatesNoRecordOrInstance(t *testing.T) {
	for _, resource := range []string{"count", "memory"} {
		t.Run(resource, func(t *testing.T) {
			svc, instances, store := machineService(t, 8)
			if resource == "count" {
				svc.config.MaxRunning = 1
				svc.config.MaxMemory = 0
			}
			mustStart(t, svc, "one", StartSpec{Program: "agent"})
			_, err := svc.Start(context.Background(), "refused", StartSpec{Program: "agent"})
			if !errors.Is(err, fault.Capacity) || !errors.Is(err, fault.Conflict) {
				t.Fatalf("admission refusal = %v", err)
			}
			if _, err := store.Get("refused"); !errors.Is(err, records.ErrNotFound) {
				t.Fatalf("capacity refusal created a record: %v", err)
			}
			if _, exists := instances.instances["refused"]; exists {
				t.Fatal("capacity refusal allocated an instance")
			}
		})
	}
}
