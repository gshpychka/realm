package sessions

import (
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/gshpychka/realm/packages/bay/internal/fault"
	"github.com/gshpychka/realm/packages/bay/internal/records"
)

func TestFreshDeclarationRejectionIsTerminalBeforeSessionCreation(t *testing.T) {
	for _, test := range []struct {
		name string
		spec StartSpec
		kind error
	}{
		{"stale-machine", StartSpec{Program: "agent", MachineRevision: strings.Repeat("a", 64)}, fault.Conflict},
		{"missing-program", StartSpec{Program: "removed-agent"}, fault.Invalid},
		{"missing-repo-ref", StartSpec{Program: "agent", Repos: []RepoRef{{Owner: "owner", Name: "repo", Ref: "missing"}}}, fault.Invalid},
		{"duplicate-repo", StartSpec{Program: "agent", Repos: []RepoRef{{Owner: "owner", Name: "repo"}, {Owner: "owner", Name: "repo"}}}, fault.Invalid},
	} {
		t.Run(test.name, func(t *testing.T) {
			svc, instances, store := machineService(t, 16)
			_, err := svc.Start(context.Background(), "refused", test.spec)
			if fault.Code(err) != fault.LaunchRejectedCode || !errors.Is(err, test.kind) {
				t.Fatalf("declaration rejection = %v, code %q; want %v and %q", err, fault.Code(err), test.kind, fault.LaunchRejectedCode)
			}
			if _, err := store.Get("refused"); !errors.Is(err, records.ErrNotFound) {
				t.Fatalf("rejected declaration created a record: %v", err)
			}
			if _, exists := instances.instances["refused"]; exists {
				t.Fatal("rejected declaration created an instance")
			}
		})
	}
}

func TestExistingOrPersistedLaunchFailuresAreNeverDefiniteRejections(t *testing.T) {
	svc, instances, store := machineService(t, 16)
	mustStart(t, svc, "one", StartSpec{Program: "agent"})
	_, err := svc.Start(context.Background(), "one", StartSpec{Program: "agent"})
	if !errors.Is(err, fault.Conflict) || fault.Code(err) != "" {
		t.Fatalf("existing session conflict gained launch semantics: %v, code %q", err, fault.Code(err))
	}
	// Simulate a record appearing after the fresh-name lookup. A create conflict says nothing about who launched it.
	_, err = svc.newRecord(context.Background(), "one", StartSpec{Program: "agent"})
	if !errors.Is(err, fault.Conflict) || fault.Code(err) != "" {
		t.Fatalf("record creation conflict gained launch semantics: %v, code %q", err, fault.Code(err))
	}
	instances.failOn = "launch"
	instances.deleteFails = true
	_, err = svc.Start(context.Background(), "partial", StartSpec{Program: "agent"})
	if err == nil || fault.Code(err) != "" {
		t.Fatalf("post-create boot failure gained launch semantics: %v, code %q", err, fault.Code(err))
	}
	if _, err := store.Get("partial"); err != nil {
		t.Fatalf("fixture did not retain the uncertain session: %v", err)
	}
}
