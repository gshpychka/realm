package main

import (
	"testing"
	"time"

	"github.com/gshpychka/realm/packages/bay/internal/identity"
	"github.com/gshpychka/realm/packages/bay/internal/records"
	"github.com/gshpychka/realm/packages/bay/internal/sessions"
)

func TestToIdentityKeepsOnlyIDAndName(t *testing.T) {
	rec := records.Record{
		ID:      "id-one",
		Name:    "one",
		Program: records.Program{Definition: "claude"},
		Repos:   []records.Repo{{Owner: "o", Name: "r", Commit: "abc"}},
		Created: time.Now(),
	}
	if got := toIdentity(rec); got != (identity.Session{ID: "id-one", Name: "one"}) {
		t.Fatalf("toIdentity = %+v", got)
	}
}

func TestPublicSessionRetainsStableIdentity(t *testing.T) {
	got := toAPI(sessions.Session{Record: records.Record{ID: "id-one", Name: "one"}, State: sessions.Running})
	if got.ID != "id-one" || got.Name != "one" {
		t.Fatalf("public session = %+v", got)
	}
}
