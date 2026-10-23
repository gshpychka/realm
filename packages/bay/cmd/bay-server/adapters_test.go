package main

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/gshpychka/realm/packages/bay/internal/api"
	"github.com/gshpychka/realm/packages/bay/internal/fault"
	"github.com/gshpychka/realm/packages/bay/internal/identity"
	"github.com/gshpychka/realm/packages/bay/internal/records"
	"github.com/gshpychka/realm/packages/bay/internal/sessions"
)

func TestMalformedStartRepoIsRejectedBeforeReachingTheSessionService(t *testing.T) {
	// A nil service proves malformed repository syntax never reaches a session allocation path.
	_, err := (operatorAPI{}).Start(context.Background(), "one", api.Start{Repos: []string{"missing-owner-and-name"}})
	if !errors.Is(err, fault.Invalid) || fault.Code(err) != fault.LaunchRejectedCode {
		t.Fatalf("malformed repo error = %v, code %q", err, fault.Code(err))
	}
}

func TestToIdentityKeepsRecordAndExecutionIdentity(t *testing.T) {
	rec := records.Record{
		ID:         "id-one",
		Generation: 4,
		Name:       "one",
		Program:    records.Program{Definition: "claude"},
		Repos:      []records.Repo{{Owner: "o", Name: "r", Commit: "abc"}},
		Created:    time.Now(),
	}
	if got := toIdentity(rec); got != (identity.Session{ID: "id-one", Name: "one", Generation: 4}) {
		t.Fatalf("toIdentity = %+v", got)
	}
}

func TestPublicSessionRetainsStableIdentity(t *testing.T) {
	got := toAPI(sessions.Session{Record: records.Record{ID: "id-one", Name: "one"}, State: sessions.Running})
	if got.ID != "id-one" || got.Name != "one" {
		t.Fatalf("public session = %+v", got)
	}
}
