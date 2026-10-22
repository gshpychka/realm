package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/gshpychka/realm/packages/bay/internal/fault"
	"github.com/gshpychka/realm/packages/bay/internal/messages"
	"github.com/gshpychka/realm/packages/bay/internal/sessionapi"
	"github.com/modelcontextprotocol/go-sdk/mcp"
)

var sentAt = time.Date(2026, 10, 5, 12, 0, 0, 0, time.UTC)

// stub is a gateway: an SDK server, stateless with JSON responses, that serves the sessionapi tools and records what
// it receives.
type stub struct {
	srv *httptest.Server

	mu           sync.Mutex
	requests     []request
	sends        []sessionapi.SendInput
	reads        []sessionapi.ReadInput
	events       []sessionapi.Event
	dials        int
	threads      []messages.Thread
	conversation messages.Conversation
	hold         chan struct{}
}

// request is one HTTP request the stub received.
type request struct {
	method string // the JSON-RPC method
	header http.Header
	remote string
}

func newStub(t *testing.T) *stub {
	t.Helper()
	thread := messages.Thread{
		ID: 7, Subject: "plan", Participants: []string{"alpha", "operator"}, Messages: 2, Unread: 1, Updated: sentAt,
	}
	s := &stub{
		threads: []messages.Thread{thread},
		conversation: messages.Conversation{
			Thread: thread,
			Messages: []messages.Message{
				{ID: 41, Thread: 7, From: "alpha", To: "operator", Body: "first line\nsecond line\n\nafter a blank", Sent: sentAt},
				{ID: 42, Thread: 7, From: "operator", To: "alpha", Body: "ok", Sent: sentAt.Add(5 * time.Minute)},
			},
		},
	}

	server := mcp.NewServer(&mcp.Implementation{Name: "stub", Version: "test"}, nil)
	mcp.AddTool(server, &mcp.Tool{Name: sessionapi.Whoami}, s.whoami)
	mcp.AddTool(server, &mcp.Tool{Name: sessionapi.Send}, s.send)
	mcp.AddTool(server, &mcp.Tool{Name: sessionapi.Inbox}, s.inbox)
	mcp.AddTool(server, &mcp.Tool{Name: sessionapi.Read}, s.read)
	mcp.AddTool(server, &mcp.Tool{Name: sessionapi.Notify}, s.notify)
	handler := mcp.NewStreamableHTTPHandler(func(*http.Request) *mcp.Server { return server }, &mcp.StreamableHTTPOptions{
		Stateless:    true,
		JSONResponse: true,
		// The listener is on loopback while flare addresses the gateway by a fixed host name.
		DisableLocalhostProtection: true,
	})
	s.srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		s.record(r)
		handler.ServeHTTP(w, r)
	}))
	t.Cleanup(s.srv.Close)
	return s
}

func (s *stub) record(r *http.Request) {
	body, _ := io.ReadAll(r.Body)
	r.Body = io.NopCloser(bytes.NewReader(body))
	var m struct{ Method string }
	_ = json.Unmarshal(body, &m)
	s.mu.Lock()
	defer s.mu.Unlock()
	s.requests = append(s.requests, request{method: m.Method, header: r.Header.Clone(), remote: r.RemoteAddr})
}

// dial reaches the stub, whatever address it is asked for.
func (s *stub) dial(ctx context.Context, network, addr string) (net.Conn, error) {
	s.mu.Lock()
	s.dials++
	s.mu.Unlock()
	return dialTo(s.srv)(ctx, network, addr)
}

// dialTo reaches srv, whatever address it is asked for.
func dialTo(srv *httptest.Server) dialFunc {
	return func(ctx context.Context, _, _ string) (net.Conn, error) {
		var d net.Dialer
		return d.DialContext(ctx, "tcp", srv.Listener.Addr().String())
	}
}

func refuse(context.Context, string, string) (net.Conn, error) {
	return nil, errors.New("connection refused")
}

// holdWhoami makes whoami wait until the returned function is called, or the test ends.
func (s *stub) holdWhoami(t *testing.T) (release func()) {
	t.Helper()
	hold := make(chan struct{})
	s.mu.Lock()
	s.hold = hold
	s.mu.Unlock()
	var once sync.Once
	release = func() { once.Do(func() { close(hold) }) }
	t.Cleanup(release)
	return release
}

func (s *stub) whoami(ctx context.Context, _ *mcp.CallToolRequest, _ struct{}) (*mcp.CallToolResult, sessionapi.WhoamiOutput, error) {
	s.mu.Lock()
	hold := s.hold
	s.mu.Unlock()
	if hold != nil {
		select {
		case <-hold:
		case <-ctx.Done():
		}
	}
	return nil, sessionapi.WhoamiOutput{Name: "alpha"}, nil
}

func (s *stub) send(_ context.Context, _ *mcp.CallToolRequest, in sessionapi.SendInput) (*mcp.CallToolResult, sessionapi.SendOutput, error) {
	if in.To == "ghost" {
		return nil, sessionapi.SendOutput{}, fmt.Errorf("%w: session %q", fault.NotFound, in.To)
	}
	s.mu.Lock()
	s.sends = append(s.sends, in)
	s.mu.Unlock()
	thread := in.Thread
	if thread == 0 {
		thread = 7
	}
	return nil, sessionapi.SendOutput{Thread: thread, Message: 42}, nil
}

func (s *stub) inbox(context.Context, *mcp.CallToolRequest, struct{}) (*mcp.CallToolResult, sessionapi.InboxOutput, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return nil, sessionapi.InboxOutput{Threads: s.threads}, nil
}

func (s *stub) read(_ context.Context, _ *mcp.CallToolRequest, in sessionapi.ReadInput) (*mcp.CallToolResult, sessionapi.ReadOutput, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.reads = append(s.reads, in)
	if in.Thread != s.conversation.Thread.ID {
		return nil, sessionapi.ReadOutput{}, fmt.Errorf("%w: thread %d", fault.NotFound, in.Thread)
	}
	return nil, s.conversation, nil
}

func (s *stub) notify(_ context.Context, _ *mcp.CallToolRequest, in sessionapi.NotifyInput) (*mcp.CallToolResult, sessionapi.NotifyOutput, error) {
	s.mu.Lock()
	s.events = append(s.events, in.Event)
	s.mu.Unlock()
	return nil, sessionapi.NotifyOutput{}, nil
}

// hang is a gateway that reads a request and never answers it; the server notices the client giving up only once it
// has read the request.
func hang() http.Handler {
	return http.HandlerFunc(func(_ http.ResponseWriter, r *http.Request) {
		io.Copy(io.Discard, r.Body)
		<-r.Context().Done()
	})
}

// flare runs the flare command line against the stub.
func (s *stub) flare(stdin string, args ...string) (code int, stdout, stderr string) {
	var out, errs bytes.Buffer
	a := &app{stdin: strings.NewReader(stdin), stdout: &out, stderr: &errs, gateway: gateway{dial: s.dial}}
	code = a.run(context.Background(), args)
	return code, out.String(), errs.String()
}
