package gateway_test

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	"github.com/gshpychka/realm/packages/bay/internal/fault"
	"github.com/gshpychka/realm/packages/bay/internal/gateway"
	"github.com/gshpychka/realm/packages/bay/internal/gateway/store"
	"github.com/gshpychka/realm/packages/bay/internal/identity"
	"github.com/gshpychka/realm/packages/bay/internal/messages"
	"github.com/gshpychka/realm/packages/bay/internal/sessionapi"
	"github.com/modelcontextprotocol/go-sdk/mcp"
)

var (
	alice = identity.Session{ID: "id-alice", Name: "alice"}
	bob   = identity.Session{ID: "id-bob", Name: "bob"}
	carol = identity.Session{ID: "id-carol", Name: "carol"}
	// dave has ended: messaging knows him, but no running VM calls as him.
	dave = identity.Session{ID: "id-dave", Name: "dave"}
	// aliceAgain is a later session that takes alice's name once her session is removed.
	aliceAgain = identity.Session{ID: "id-alice-2", Name: "alice"}
)

// operator is the operator as the store knows it.
var operator = gateway.Participant{ID: messages.Operator, Name: messages.Operator}

// The vsock context IDs of the running sessions' VMs.
const (
	aliceCID uint32 = 10
	bobCID   uint32 = 20
	carolCID uint32 = 30
	// aliceAgainCID is the VM of aliceAgain.
	aliceAgainCID uint32 = 40
)

// fakeResolver knows sessions by name and running sessions by context ID.
type fakeResolver struct {
	mu         sync.Mutex
	callers    map[uint32]identity.Session
	sessions   map[string]identity.Session
	callerErr  error
	sessionErr error
}

func newResolver() *fakeResolver {
	return &fakeResolver{
		callers:  map[uint32]identity.Session{aliceCID: alice, bobCID: bob, carolCID: carol},
		sessions: map[string]identity.Session{"alice": alice, "bob": bob, "carol": carol, "dave": dave},
	}
}

func (f *fakeResolver) Caller(_ context.Context, cid uint32) (identity.Session, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.callerErr != nil {
		return identity.Session{}, f.callerErr
	}
	s, ok := f.callers[cid]
	if !ok {
		return identity.Session{}, fmt.Errorf("%w: no running session at context ID %d", fault.NotFound, cid)
	}
	return s, nil
}

func (f *fakeResolver) Session(_ context.Context, name string) (identity.Session, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.sessionErr != nil {
		return identity.Session{}, f.sessionErr
	}
	s, ok := f.sessions[name]
	if !ok {
		return identity.Session{}, fmt.Errorf("%w: no session named %s", fault.NotFound, name)
	}
	return s, nil
}

// failCallers makes every caller lookup fail with err.
func (f *fakeResolver) failCallers(err error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.callerErr = err
}

// failSessions makes every session lookup fail with err.
func (f *fakeResolver) failSessions(err error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.sessionErr = err
}

// setCaller changes which session runs at cid; the zero Session removes it.
func (f *fakeResolver) setCaller(cid uint32, s identity.Session) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if s == (identity.Session{}) {
		delete(f.callers, cid)
		return
	}
	f.callers[cid] = s
}

// setSession changes which session holds name; the zero Session removes it.
func (f *fakeResolver) setSession(name string, s identity.Session) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if s == (identity.Session{}) {
		delete(f.sessions, name)
		return
	}
	f.sessions[name] = s
}

type alert struct{ session, event string }

// fakeAlerter records the alerts it is given.
type fakeAlerter struct {
	mu     sync.Mutex
	alerts []alert
	err    error
}

func (f *fakeAlerter) Alert(_ context.Context, session, event string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.err != nil {
		return f.err
	}
	f.alerts = append(f.alerts, alert{session, event})
	return nil
}

// fail makes every alert fail with err.
func (f *fakeAlerter) fail(err error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.err = err
}

func (f *fakeAlerter) got() []alert {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]alert(nil), f.alerts...)
}

// syncBuffer is a log destination safe for concurrent use.
type syncBuffer struct {
	mu  sync.Mutex
	buf bytes.Buffer
}

func (b *syncBuffer) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.Write(p)
}

func (b *syncBuffer) String() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.String()
}

// lines returns the JSON log records written so far.
func (b *syncBuffer) lines(t *testing.T) []map[string]any {
	t.Helper()
	var out []map[string]any
	for _, line := range strings.Split(strings.TrimSpace(b.String()), "\n") {
		if line == "" {
			continue
		}
		var rec map[string]any
		if err := json.Unmarshal([]byte(line), &rec); err != nil {
			t.Fatalf("log line %q: %v", line, err)
		}
		out = append(out, rec)
	}
	return out
}

// env is a gateway over a real store, with fake identities and alerts.
type env struct {
	t        *testing.T
	gateway  *gateway.Gateway
	store    *store.Store
	resolver *fakeResolver
	alerter  *fakeAlerter
	logs     *syncBuffer
}

// newEnv returns an env whose gateway runs with the configuration that opts adjust.
func newEnv(t *testing.T, opts ...func(*gateway.Config)) *env {
	t.Helper()
	st, err := store.Open(filepath.Join(t.TempDir(), "messages.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { st.Close() })
	e := &env{t: t, store: st, resolver: newResolver(), alerter: &fakeAlerter{}, logs: &syncBuffer{}}
	cfg := gateway.Config{Resolver: e.resolver, Store: st, Alerter: e.alerter, Log: slog.New(slog.NewJSONHandler(e.logs, nil))}
	for _, opt := range opts {
		opt(&cfg)
	}
	e.gateway = gateway.New(cfg)
	return e
}

// withoutAlerter leaves the gateway with no alerter.
func withoutAlerter(c *gateway.Config) { c.Alerter = nil }

// withStore runs the gateway over s.
func withStore(s gateway.Store) func(*gateway.Config) {
	return func(c *gateway.Config) { c.Store = s }
}

// serveAs starts h on a server whose connections all come from the VM with context ID cid.
func serveAs(t *testing.T, h http.Handler, cid uint32) *httptest.Server {
	t.Helper()
	srv := httptest.NewUnstartedServer(h)
	srv.Config.ConnContext = func(ctx context.Context, _ net.Conn) context.Context { return gateway.WithPeer(ctx, cid) }
	srv.Start()
	t.Cleanup(srv.Close)
	return srv
}

// serveWithoutPeer starts h on a server whose connections carry no peer.
func serveWithoutPeer(t *testing.T, h http.Handler) *httptest.Server {
	t.Helper()
	srv := httptest.NewServer(h)
	t.Cleanup(srv.Close)
	return srv
}

// connect opens an MCP session to the gateway as the VM with context ID cid. Requests carry the extra headers.
func (e *env) connect(cid uint32, headers ...string) *mcp.ClientSession {
	e.t.Helper()
	srv := serveAs(e.t, e.gateway.SessionHandler(), cid)
	return connect(e.t, srv.URL, headers...)
}

func connect(t *testing.T, base string, headers ...string) *mcp.ClientSession {
	t.Helper()
	cs, err := newClient().Connect(context.Background(), transport(base, headers...), nil)
	if err != nil {
		t.Fatalf("connect: %v", err)
	}
	t.Cleanup(func() { cs.Close() })
	return cs
}

func newClient() *mcp.Client {
	return mcp.NewClient(&mcp.Implementation{Name: "test", Version: "1"}, nil)
}

func transport(base string, headers ...string) *mcp.StreamableClientTransport {
	return &mcp.StreamableClientTransport{
		Endpoint:             base + sessionapi.Path,
		HTTPClient:           &http.Client{Transport: withHeaders(headers)},
		DisableStandaloneSSE: true,
	}
}

// withHeaders adds header name and value pairs to every request.
func withHeaders(pairs []string) http.RoundTripper {
	return roundTripper(func(r *http.Request) (*http.Response, error) {
		r = r.Clone(r.Context())
		for i := 0; i+1 < len(pairs); i += 2 {
			r.Header.Set(pairs[i], pairs[i+1])
		}
		return http.DefaultTransport.RoundTrip(r)
	})
}

type roundTripper func(*http.Request) (*http.Response, error)

func (f roundTripper) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

// call invokes a tool; a protocol failure ends the test, a tool failure is in the result.
func call(t *testing.T, cs *mcp.ClientSession, tool string, args any) *mcp.CallToolResult {
	t.Helper()
	res, err := cs.CallTool(context.Background(), &mcp.CallToolParams{Name: tool, Arguments: args})
	if err != nil {
		t.Fatalf("%s: %v", tool, err)
	}
	return res
}

// text returns the text a result carries, which is the message of a failed call.
func text(res *mcp.CallToolResult) string {
	var parts []string
	for _, c := range res.Content {
		if tc, ok := c.(*mcp.TextContent); ok {
			parts = append(parts, tc.Text)
		}
	}
	return strings.Join(parts, "\n")
}

// decode returns the structured output of a call that succeeded.
func decode[T any](res *mcp.CallToolResult) (T, error) {
	var out T
	if res.IsError {
		return out, fmt.Errorf("the call failed: %s", text(res))
	}
	data, err := json.Marshal(res.StructuredContent)
	if err != nil {
		return out, err
	}
	if err := json.Unmarshal(data, &out); err != nil {
		return out, fmt.Errorf("decoding %s: %w", data, err)
	}
	return out, nil
}

// result is decode for a test that cannot go on without the output.
func result[T any](t *testing.T, res *mcp.CallToolResult) T {
	t.Helper()
	out, err := decode[T](res)
	if err != nil {
		t.Fatal(err)
	}
	return out
}

// refused checks that a call failed and returns its message.
func refused(t *testing.T, res *mcp.CallToolResult) string {
	t.Helper()
	if !res.IsError {
		t.Fatalf("the call succeeded with %v, want a tool error", res.StructuredContent)
	}
	return text(res)
}

// post sends one raw JSON-RPC request to the endpoint under base.
func post(t *testing.T, base, body string) (int, string) {
	t.Helper()
	req, err := http.NewRequest(http.MethodPost, base+sessionapi.Path, strings.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json, text/event-stream")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	data, _ := io.ReadAll(resp.Body)
	return resp.StatusCode, string(data)
}

const whoamiRequest = `{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"whoami","arguments":{}}}`

var (
	errAlertDown    = errors.New("ntfy: 502 upstream unreachable at ntfy.internal.example")
	errDiskGone     = errors.New("write /var/lib/bay-gateway/messages.db: input/output error")
	errIdentityDown = errors.New("dial unix /run/bay/identity.sock: connect: connection refused")
)

// brokenStore fails every operation with an error that is no fault kind.
type brokenStore struct{}

func (brokenStore) Deliver(context.Context, gateway.Participant, gateway.Participant, messages.Send) (gateway.Delivery, error) {
	return gateway.Delivery{}, errDiskGone
}

func (brokenStore) Receipt(context.Context, gateway.Participant, messages.Send) (*messages.Message, error) {
	return nil, errDiskGone
}
func (brokenStore) Inbox(context.Context, gateway.Participant) ([]messages.Thread, error) {
	return nil, errDiskGone
}

func (brokenStore) Conversation(context.Context, gateway.Participant, int64, int64) (messages.Conversation, error) {
	return messages.Conversation{}, errDiskGone
}

func (brokenStore) Threads(context.Context, gateway.Participant) ([]messages.Thread, error) {
	return nil, errDiskGone
}
