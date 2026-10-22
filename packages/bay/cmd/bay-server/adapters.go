package main

import (
	"context"

	"github.com/gshpychka/realm/packages/bay/internal/api"
	"github.com/gshpychka/realm/packages/bay/internal/identity"
	"github.com/gshpychka/realm/packages/bay/internal/records"
	"github.com/gshpychka/realm/packages/bay/internal/sessions"
)

// operatorAPI serves the session service through the API contract.
type operatorAPI struct {
	svc *sessions.Service
}

func (o operatorAPI) List(ctx context.Context) ([]api.Session, error) {
	all, err := o.svc.List(ctx)
	if err != nil {
		return nil, err
	}
	out := make([]api.Session, 0, len(all))
	for _, s := range all {
		out = append(out, toAPI(s))
	}
	return out, nil
}

func (o operatorAPI) Get(ctx context.Context, name string) (api.Session, error) {
	s, err := o.svc.Get(ctx, name)
	return toAPI(s), err
}

func (o operatorAPI) Start(ctx context.Context, name string, start api.Start) (api.Session, error) {
	refs, err := parseRepos(start.Repos)
	if err != nil {
		return api.Session{}, err
	}
	s, err := o.svc.Start(ctx, name, sessions.StartSpec{Program: start.Program, Command: start.Command, Repos: refs})
	return toAPI(s), err
}

func (o operatorAPI) Suspend(ctx context.Context, name string) error {
	return o.svc.Suspend(ctx, name)
}

func (o operatorAPI) Resume(ctx context.Context, name string, r api.Resume) error {
	return o.svc.Resume(ctx, name, r.Snapshot, r.Discard)
}

func (o operatorAPI) Snap(ctx context.Context, name string, s api.Snap) (api.Snapped, error) {
	snapshot, err := o.svc.Snap(ctx, name, s.Snapshot)
	return api.Snapped{Snapshot: snapshot}, err
}

func (o operatorAPI) End(ctx context.Context, name string, e api.End) error {
	return o.svc.End(ctx, name, e.Snapshots)
}

func (o operatorAPI) Remove(ctx context.Context, name string) error {
	return o.svc.Remove(ctx, name)
}

func (o operatorAPI) Attach(ctx context.Context, name string) (api.Attach, error) {
	command, err := o.svc.AttachCommand(ctx, name)
	return api.Attach{Command: command}, err
}

func parseRepos(specs []string) ([]sessions.RepoRef, error) {
	refs := make([]sessions.RepoRef, 0, len(specs))
	for _, spec := range specs {
		ref, err := api.ParseRepo(spec)
		if err != nil {
			return nil, err
		}
		refs = append(refs, sessions.RepoRef{Owner: ref.Owner, Name: ref.Name, Ref: ref.Ref})
	}
	return refs, nil
}

func toAPI(s sessions.Session) api.Session {
	out := api.Session{
		Name:      s.Name,
		State:     api.State(s.State),
		Program:   s.Program.Definition,
		Command:   s.Program.Command,
		Created:   s.Created,
		Snapshots: s.Snapshots,
	}
	for _, r := range s.Repos {
		out.Repos = append(out.Repos, toAPIRepo(r))
	}
	return out
}

func toAPIRepo(r records.Repo) api.Repo {
	return api.Repo{Owner: r.Owner, Name: r.Name, Branch: r.Branch, Commit: r.Commit}
}

// resolver serves the session service through the identity contract.
type resolver struct {
	svc *sessions.Service
}

func (r resolver) Caller(ctx context.Context, cid uint32) (identity.Session, error) {
	rec, err := r.svc.Caller(ctx, cid)
	return toIdentity(rec), err
}

func (r resolver) Session(ctx context.Context, name string) (identity.Session, error) {
	rec, err := r.svc.Lookup(name)
	return toIdentity(rec), err
}

func toIdentity(rec records.Record) identity.Session {
	return identity.Session{ID: rec.ID, Name: rec.Name}
}
