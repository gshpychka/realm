package identity

import (
	"errors"
	"testing"

	"github.com/gshpychka/realm/packages/bay/internal/fault"
)

func TestExecutionGenerationRequiresRecordID(t *testing.T) {
	generation := uint64(1)
	session := Session{ID: "replacement", Name: "one", Generation: generation}
	if err := (Precondition{Generation: &generation}).Check(session); !errors.Is(err, fault.Invalid) {
		t.Fatalf("generation-only precondition accepted a reusable name: %v", err)
	}
	if err := (Precondition{ID: session.ID, Generation: &generation}).Check(session); err != nil {
		t.Fatal(err)
	}
}
