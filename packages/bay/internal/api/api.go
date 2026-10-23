// Package api is the Bay server's API: sessions and the operator's messaging.
package api

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/gshpychka/realm/packages/bay/internal/fault"
	"github.com/gshpychka/realm/packages/bay/internal/identity"
	"github.com/gshpychka/realm/packages/bay/internal/messages"
	"github.com/gshpychka/realm/packages/bay/internal/wire"
)

// State is where a session is in its lifecycle.
type State string

const (
	// Running: the session's instance is up.
	Running State = "running"
	// Suspended: the session's instance is saved with its disk and memory.
	Suspended State = "suspended"
	// Ended: only the session's record remains.
	Ended State = "ended"
)

type Session struct {
	// ID stays the same across starts and changes when a removed name is reused.
	ID         string `json:"id"`
	Generation uint64 `json:"generation"`
	Name       string `json:"name"`
	State      State  `json:"state"`
	// Program names the session's program definition; empty when the session runs Command.
	Program         string       `json:"program,omitempty"`
	Command         []string     `json:"command,omitempty"`
	Repos           []Repo       `json:"repos,omitempty"`
	Created         time.Time    `json:"created"`
	Capabilities    Capabilities `json:"capabilities"`
	Machine         string       `json:"machine,omitempty"`
	MachineRevision string       `json:"machineRevision,omitempty"`
	// Snapshots are the snapshots of a running or suspended session, oldest first.
	Snapshots []string `json:"snapshots,omitempty"`
}

// Capabilities describe the configured program, independently of session state.
type Capabilities struct {
	Connect bool `json:"connect"`
}

type Repo struct {
	Owner  string `json:"owner"`
	Name   string `json:"name"`
	Branch string `json:"branch,omitempty"`
	Commit string `json:"commit"`
}

// Start describes a new session. With no program, command or repos it starts an ended session again from its record.
// Identity and machine revision fields are expectations, not replacement configuration.
type Start struct {
	ID         string  `json:"id,omitempty"`
	Generation *uint64 `json:"generation,omitempty"`
	// MachineRevision is an optional precondition on the program's declared machine.
	MachineRevision string `json:"machineRevision,omitempty"`
	// Program names a program definition. With neither Program nor Command the session runs a login shell.
	Program string   `json:"program,omitempty"`
	Command []string `json:"command,omitempty"`
	// Repos are "owner/name" or "owner/name@ref"; a missing ref means the default branch.
	Repos []string `json:"repos,omitempty"`
}

// RepoRef is one entry of Start.Repos, parsed.
type RepoRef struct {
	Owner, Name, Ref string
}

// ParseRepo parses "owner/name" or "owner/name@ref".
func ParseRepo(spec string) (RepoRef, error) {
	repo, ref, hasRef := strings.Cut(spec, "@")
	owner, name, ok := strings.Cut(repo, "/")
	if !ok || owner == "" || name == "" || strings.Contains(name, "/") || (hasRef && ref == "") {
		return RepoRef{}, fmt.Errorf("%w: repo %q is not owner/name or owner/name@ref", fault.Invalid, spec)
	}
	return RepoRef{Owner: owner, Name: name, Ref: ref}, nil
}

type Resume struct {
	ID         string  `json:"id,omitempty"`
	Generation *uint64 `json:"generation,omitempty"`
	// Snapshot, when set, rolls the session back to that snapshot.
	Snapshot string `json:"snapshot,omitempty"`
	// Discard are the later snapshots the operator agreed to delete; rolling back fails unless they are exactly
	// the snapshots taken after Snapshot.
	Discard []string `json:"discard,omitempty"`
}

type Suspend struct {
	// ID, when set, requires the same record even if the name was removed and reused.
	ID         string  `json:"id,omitempty"`
	Generation *uint64 `json:"generation,omitempty"`
}

type Snap struct {
	ID         string  `json:"id,omitempty"`
	Generation *uint64 `json:"generation,omitempty"`
	// Snapshot names the snapshot; empty picks a name.
	Snapshot string `json:"snapshot,omitempty"`
}

type Snapped struct {
	Snapshot string `json:"snapshot"`
}

type End struct {
	// ID, when set, requires the same record even if the name was removed and reused.
	ID         string  `json:"id,omitempty"`
	Generation *uint64 `json:"generation,omitempty"`
	// Snapshots are the snapshots the operator agreed to delete; ending fails unless they are exactly the
	// session's snapshots.
	Snapshots []string `json:"snapshots"`
}

type Attach struct {
	// Command, run in the operator's terminal on the host, attaches it to the session's program.
	Command []string `json:"command"`
}

// Service is the Bay server's session operations.
type Service interface {
	Operations
	// List returns every session, without their snapshots.
	List(ctx context.Context) ([]Session, error)
	Get(ctx context.Context, name string) (Session, error)
	Start(ctx context.Context, name string, s Start) (Session, error)
	Suspend(ctx context.Context, name string, s Suspend) error
	Resume(ctx context.Context, name string, r Resume) error
	Snap(ctx context.Context, name string, s Snap) (Snapped, error)
	End(ctx context.Context, name string, e End) error
	Remove(ctx context.Context, name string, expected ...identity.Precondition) error
	Attach(ctx context.Context, name string) (Attach, error)
	// Connect opens the configured program's byte stream, bound to a session ID.
	Connect(ctx context.Context, name, id string, generation ...uint64) (io.ReadWriteCloser, error)
}

// messagesPrefix is where the API carries the operator's messaging.
const messagesPrefix = "/v1/messages"

// Handler serves svc, and messaging through msgs, which serves the messages contract.
func Handler(svc Service, msgs http.Handler) http.Handler {
	mux := http.NewServeMux()
	operationsHandler(mux, svc)
	mux.HandleFunc("GET /v1/sessions", func(w http.ResponseWriter, r *http.Request) {
		sessions, err := svc.List(r.Context())
		respond(w, sessions, err)
	})
	mux.HandleFunc("GET /v1/sessions/{name}", func(w http.ResponseWriter, r *http.Request) {
		s, err := svc.Get(r.Context(), r.PathValue("name"))
		respond(w, s, err)
	})
	mux.HandleFunc("POST /v1/sessions/{name}/start", func(w http.ResponseWriter, r *http.Request) {
		var start Start
		if err := wire.Read(r, &start); err != nil {
			wire.Fail(w, err)
			return
		}
		s, err := svc.Start(r.Context(), r.PathValue("name"), start)
		respond(w, s, err)
	})
	mux.HandleFunc("POST /v1/sessions/{name}/suspend", func(w http.ResponseWriter, r *http.Request) {
		var suspend Suspend
		if err := wire.Read(r, &suspend); err != nil {
			wire.Fail(w, err)
			return
		}
		respond(w, struct{}{}, svc.Suspend(r.Context(), r.PathValue("name"), suspend))
	})
	mux.HandleFunc("POST /v1/sessions/{name}/resume", func(w http.ResponseWriter, r *http.Request) {
		var resume Resume
		if err := wire.Read(r, &resume); err != nil {
			wire.Fail(w, err)
			return
		}
		respond(w, struct{}{}, svc.Resume(r.Context(), r.PathValue("name"), resume))
	})
	mux.HandleFunc("POST /v1/sessions/{name}/snapshots", func(w http.ResponseWriter, r *http.Request) {
		var snap Snap
		if err := wire.Read(r, &snap); err != nil {
			wire.Fail(w, err)
			return
		}
		snapped, err := svc.Snap(r.Context(), r.PathValue("name"), snap)
		respond(w, snapped, err)
	})
	mux.HandleFunc("POST /v1/sessions/{name}/end", func(w http.ResponseWriter, r *http.Request) {
		var end End
		if err := wire.Read(r, &end); err != nil {
			wire.Fail(w, err)
			return
		}
		respond(w, struct{}{}, svc.End(r.Context(), r.PathValue("name"), end))
	})
	mux.HandleFunc("DELETE /v1/sessions/{name}", func(w http.ResponseWriter, r *http.Request) {
		expected := identity.Precondition{ID: r.URL.Query().Get("id")}
		if value, ok := r.URL.Query()["generation"]; ok {
			if len(value) != 1 {
				wire.Fail(w, fmt.Errorf("%w: one execution generation is required", fault.Invalid))
				return
			}
			generation, err := strconv.ParseUint(value[0], 10, 64)
			if err != nil {
				wire.Fail(w, fmt.Errorf("%w: invalid execution generation", fault.Invalid))
				return
			}
			expected.Generation = &generation
		}
		respond(w, struct{}{}, svc.Remove(r.Context(), r.PathValue("name"), expected))
	})
	mux.HandleFunc("GET /v1/sessions/{name}/attach", func(w http.ResponseWriter, r *http.Request) {
		a, err := svc.Attach(r.Context(), r.PathValue("name"))
		respond(w, a, err)
	})
	mux.HandleFunc("POST /v1/sessions/{name}/connect", connectHandler(svc))
	mux.HandleFunc("POST /v1/sessions/{name}/environment", environmentHandler(svc))
	// This relay is available only through the operator socket, alongside lifecycle operations.
	mux.Handle("POST /v1/sessions/{name}/messages", http.StripPrefix("/v1", msgs))
	mux.Handle(messagesPrefix+"/", http.StripPrefix(messagesPrefix, msgs))
	return mux
}

func respond(w http.ResponseWriter, v any, err error) {
	if err != nil {
		wire.Fail(w, err)
		return
	}
	wire.Write(w, http.StatusOK, v)
}

// Client uses the API served by Handler on a unix socket.
type Client struct {
	c wire.Client
}

const base = "http://bay"

// NewClient returns a client of the API listening on the unix socket at path.
func NewClient(path string) *Client {
	return &Client{c: wire.Client{HTTP: wire.Unix(path), Base: base}}
}

func sessionPath(name string, rest string) string {
	return "/v1/sessions/" + url.PathEscape(name) + rest
}

func (c *Client) List(ctx context.Context) ([]Session, error) {
	var sessions []Session
	err := c.c.Do(ctx, http.MethodGet, "/v1/sessions", nil, &sessions)
	return sessions, err
}

func (c *Client) Get(ctx context.Context, name string) (Session, error) {
	var s Session
	err := c.c.Do(ctx, http.MethodGet, sessionPath(name, ""), nil, &s)
	return s, err
}

func (c *Client) Start(ctx context.Context, name string, start Start) (Session, error) {
	var s Session
	err := c.c.Do(ctx, http.MethodPost, sessionPath(name, "/start"), start, &s)
	return s, err
}

func (c *Client) Suspend(ctx context.Context, name string, expectedID ...string) error {
	var suspend Suspend
	if len(expectedID) > 0 {
		suspend.ID = expectedID[0]
	}
	return c.SuspendExact(ctx, name, suspend)
}

func (c *Client) SuspendExact(ctx context.Context, name string, s Suspend) error {
	return c.c.Do(ctx, http.MethodPost, sessionPath(name, "/suspend"), s, nil)
}

func (c *Client) Resume(ctx context.Context, name string, r Resume) error {
	return c.c.Do(ctx, http.MethodPost, sessionPath(name, "/resume"), r, nil)
}

func (c *Client) Snap(ctx context.Context, name string, s Snap) (Snapped, error) {
	var snapped Snapped
	err := c.c.Do(ctx, http.MethodPost, sessionPath(name, "/snapshots"), s, &snapped)
	return snapped, err
}

func (c *Client) End(ctx context.Context, name string, e End) error {
	return c.c.Do(ctx, http.MethodPost, sessionPath(name, "/end"), e, nil)
}

func (c *Client) Remove(ctx context.Context, name string, expected ...identity.Precondition) error {
	path := sessionPath(name, "")
	if len(expected) > 0 {
		query := url.Values{}
		if expected[0].ID != "" {
			query.Set("id", expected[0].ID)
		}
		if expected[0].Generation != nil {
			query.Set("generation", strconv.FormatUint(*expected[0].Generation, 10))
		}
		if len(query) > 0 {
			path += "?" + query.Encode()
		}
	}
	return c.c.Do(ctx, http.MethodDelete, path, nil, nil)
}

func (c *Client) Attach(ctx context.Context, name string) (Attach, error) {
	var a Attach
	err := c.c.Do(ctx, http.MethodGet, sessionPath(name, "/attach"), nil, &a)
	return a, err
}

// Messages returns the operator's messaging, reached through the API.
func (c *Client) Messages() *messages.Client {
	return messages.NewClient(c.c.HTTP, base+messagesPrefix)
}

func (c *Client) Relay(ctx context.Context, name string, r messages.Relay) (messages.Message, error) {
	var m messages.Message
	err := c.c.Do(ctx, http.MethodPost, sessionPath(name, "/messages"), r, &m)
	return m, err
}
