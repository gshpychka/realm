package main

import (
	"testing"
	"time"

	"github.com/gshpychka/realm/packages/bay/internal/identity"
	"github.com/gshpychka/realm/packages/bay/internal/records"
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
