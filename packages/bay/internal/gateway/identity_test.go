package gateway_test

import (
	"io"
	"log/slog"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/gshpychka/realm/packages/bay/internal/gateway"
	"github.com/gshpychka/realm/packages/bay/internal/identity"
	"github.com/gshpychka/realm/packages/bay/internal/sessionapi"
)

// The gateway asks the Bay server who a caller is through identity.Client, and a lookup that finds nobody reaches it
// as the client's not-found failure.
func TestIdentityServedOverTheWire(t *testing.T) {
	// A short directory keeps the socket path within the length limit of a unix socket address.
	dir, err := os.MkdirTemp("", "bay")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.RemoveAll(dir) })
	socket := filepath.Join(dir, "identity.sock")
	l, err := net.Listen("unix", socket)
	if err != nil {
		t.Fatal(err)
	}
	server := &http.Server{Handler: identity.Handler(newResolver())}
	go server.Serve(l)
	t.Cleanup(func() { server.Close() })

	e := newEnv(t)
	g := gateway.New(gateway.Config{Resolver: identity.NewClient(socket), Store: e.store, Alerter: e.alerter, Log: slog.New(slog.NewTextHandler(io.Discard, nil))})
	known := serveAs(t, g.SessionHandler(), aliceCID)
	stranger := serveAs(t, g.SessionHandler(), 99)
	as := connect(t, known.URL)

	if got := result[sessionapi.WhoamiOutput](t, call(t, as, sessionapi.Whoami, nil)); got.Name != "alice" {
		t.Errorf("whoami = %q, want alice", got.Name)
	}
	sent := result[sessionapi.SendOutput](t, call(t, as, sessionapi.Send, sessionapi.SendInput{To: "bob", Body: "hello"}))
	if sent.Thread == 0 {
		t.Errorf("send returned %+v", sent)
	}
	if msg := refused(t, call(t, as, sessionapi.Send, sessionapi.SendInput{To: "nobody", Body: "hello"})); !strings.Contains(msg, "not found") {
		t.Errorf("sending to an unknown session failed with %q, want a not found error", msg)
	}
	if status, _ := post(t, stranger.URL, whoamiRequest); status != http.StatusForbidden {
		t.Errorf("a context ID the Bay server does not know got status %d, want 403", status)
	}

	server.Close()
	if status, _ := post(t, known.URL, whoamiRequest); status != http.StatusInternalServerError {
		t.Errorf("a request while the Bay server is down got status %d, want 500", status)
	}
}
