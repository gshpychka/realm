// Package identity answers which session a vsock caller is and which session holds a name.
package identity

import (
	"context"
	"fmt"
	"net/http"
	"net/url"
	"strconv"

	"github.com/gshpychka/realm/packages/bay/internal/fault"
	"github.com/gshpychka/realm/packages/bay/internal/wire"
)

// Session identifies a session by its ID and its name.
type Session struct {
	// ID stays the same across the session's starts and differs for any later session reusing the name.
	ID         string `json:"id"`
	Name       string `json:"name"`
	Generation uint64 `json:"generation"`
}

// Precondition binds an operation to a record and, optionally, its current execution authority.
type Precondition struct {
	ID         string  `json:"id,omitempty"`
	Generation *uint64 `json:"generation,omitempty"`
}

func (p Precondition) Check(s Session) error {
	if p.ID != "" && p.ID != s.ID {
		return fmt.Errorf("%w: session %s has a different ID", fault.Conflict, s.Name)
	}
	if p.Generation != nil && *p.Generation != s.Generation {
		return fmt.Errorf("%w: session %s has a different execution generation", fault.Conflict, s.Name)
	}
	return nil
}

// Resolver answers identity questions; a session it does not know is a fault.NotFound.
type Resolver interface {
	// Caller returns the running session whose VM has the vsock context ID cid.
	Caller(ctx context.Context, cid uint32) (Session, error)
	// Session returns the session named name, whatever its state.
	Session(ctx context.Context, name string) (Session, error)
}

// Handler serves r.
func Handler(r Resolver) http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /callers/{cid}", func(w http.ResponseWriter, req *http.Request) {
		cid, err := strconv.ParseUint(req.PathValue("cid"), 10, 32)
		if err != nil {
			wire.Fail(w, fmt.Errorf("%w: context ID %q", fault.Invalid, req.PathValue("cid")))
			return
		}
		s, err := r.Caller(req.Context(), uint32(cid))
		respond(w, s, err)
	})
	mux.HandleFunc("GET /sessions/{name}", func(w http.ResponseWriter, req *http.Request) {
		s, err := r.Session(req.Context(), req.PathValue("name"))
		respond(w, s, err)
	})
	return mux
}

func respond(w http.ResponseWriter, s Session, err error) {
	if err != nil {
		wire.Fail(w, err)
		return
	}
	wire.Write(w, http.StatusOK, s)
}

// Client asks a Resolver served by Handler over a unix socket.
type Client struct {
	c wire.Client
}

// NewClient returns a client of the Handler listening on the unix socket at path.
func NewClient(path string) *Client {
	return &Client{c: wire.Client{HTTP: wire.Unix(path), Base: "http://bay"}}
}

func (c *Client) Caller(ctx context.Context, cid uint32) (Session, error) {
	var s Session
	err := c.c.Do(ctx, http.MethodGet, "/callers/"+strconv.FormatUint(uint64(cid), 10), nil, &s)
	return s, err
}

func (c *Client) Session(ctx context.Context, name string) (Session, error) {
	var s Session
	err := c.c.Do(ctx, http.MethodGet, "/sessions/"+url.PathEscape(name), nil, &s)
	return s, err
}
