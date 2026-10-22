package main

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"io"
	"io/fs"
	stdlog "log"
	"log/slog"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/gshpychka/realm/packages/bay/internal/fault"
	"github.com/gshpychka/realm/packages/bay/internal/gateway"
	"github.com/gshpychka/realm/packages/bay/internal/gateway/store"
	"github.com/gshpychka/realm/packages/bay/internal/identity"
	"github.com/gshpychka/realm/packages/bay/internal/sessionapi"
	"github.com/mdlayher/vsock"
)

func TestLoadConfig(t *testing.T) {
	const base = `"identitySocket":"/run/bay/identity.sock","database":"/var/lib/bay-gateway/messages.db"`
	minimal := config{IdentitySocket: "/run/bay/identity.sock", Database: "/var/lib/bay-gateway/messages.db"}
	tests := []struct {
		name    string
		json    string
		want    config
		wantErr string
	}{
		{"without ntfy", `{` + base + `}`, minimal, ""},
		{
			"with ntfy",
			`{` + base + `,"ntfy":{"url":"https://ntfy.example.com","topic":"bay"}}`,
			config{IdentitySocket: minimal.IdentitySocket, Database: minimal.Database, Ntfy: &ntfyConfig{URL: "https://ntfy.example.com", Topic: "bay"}},
			"",
		},
		{"unknown field", `{` + base + `,"ntfyToken":"tk_secret"}`, config{}, "unknown field"},
		{"a second value", `{` + base + `} {}`, config{}, "one JSON object"},
		{"unknown ntfy field", `{` + base + `,"ntfy":{"url":"u","topic":"t","token":"tk_secret"}}`, config{}, "unknown field"},
		{"no identity socket", `{"database":"/x.db"}`, config{}, "identitySocket"},
		{"no database", `{"identitySocket":"/x.sock"}`, config{}, "database"},
		{"ntfy without a url", `{` + base + `,"ntfy":{"topic":"bay"}}`, config{}, "ntfy"},
		{"ntfy without a topic", `{` + base + `,"ntfy":{"url":"https://ntfy.example.com"}}`, config{}, "ntfy"},
		{"not JSON", `identitySocket=/x.sock`, config{}, "config"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			path := filepath.Join(t.TempDir(), "gateway.json")
			if err := os.WriteFile(path, []byte(tt.json), 0o600); err != nil {
				t.Fatal(err)
			}
			got, err := loadConfig(path)
			if tt.wantErr != "" {
				if err == nil || !strings.Contains(err.Error(), tt.wantErr) {
					t.Fatalf("loadConfig returned %v, want an error mentioning %q", err, tt.wantErr)
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			if !reflect.DeepEqual(got, tt.want) {
				t.Errorf("loadConfig = %+v, want %+v", got, tt.want)
			}
		})
	}

	if _, err := loadConfig(filepath.Join(t.TempDir(), "missing.json")); !errors.Is(err, fs.ErrNotExist) {
		t.Errorf("loadConfig of a missing file returned %v, want fs.ErrNotExist", err)
	}
}

func TestReadToken(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("CREDENTIALS_DIRECTORY", dir)
	write := func(content string) {
		t.Helper()
		if err := os.WriteFile(filepath.Join(dir, tokenCredential), []byte(content), 0o600); err != nil {
			t.Fatal(err)
		}
	}

	if _, err := readToken(); err == nil {
		t.Error("readToken succeeded without a credential file")
	}
	write("tk_abc123\n")
	if got, err := readToken(); err != nil || got != "tk_abc123" {
		t.Errorf("readToken = %q (%v), want the token without its newline", got, err)
	}
	write(" \n")
	if got, err := readToken(); err == nil {
		t.Errorf("readToken accepted an empty credential and returned %q", got)
	}
	t.Setenv("CREDENTIALS_DIRECTORY", "")
	if _, err := readToken(); err == nil {
		t.Error("readToken succeeded without a credentials directory")
	}
}

// resolver knows which sessions run at which context IDs.
type resolver map[uint32]identity.Session

func (r resolver) Caller(_ context.Context, cid uint32) (identity.Session, error) {
	s, ok := r[cid]
	if !ok {
		return identity.Session{}, fmt.Errorf("%w: context ID %d", fault.NotFound, cid)
	}
	return s, nil
}

func (r resolver) Session(_ context.Context, name string) (identity.Session, error) {
	return identity.Session{}, fmt.Errorf("%w: session %s", fault.NotFound, name)
}

// vmListener makes every connection it accepts look like it comes from the VM with context ID cid.
type vmListener struct {
	net.Listener
	cid uint32
}

func (l vmListener) Accept() (net.Conn, error) {
	c, err := l.Listener.Accept()
	if err != nil {
		return nil, err
	}
	return vmConn{Conn: c, remote: &vsock.Addr{ContextID: l.cid, Port: 49152}}, nil
}

type vmConn struct {
	net.Conn
	remote net.Addr
}

func (c vmConn) RemoteAddr() net.Addr { return c.remote }

func listen(t *testing.T) net.Listener {
	t.Helper()
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { l.Close() })
	return l
}

// newGateway returns a gateway for the sessions r knows.
func newGateway(t *testing.T, r resolver) *gateway.Gateway {
	t.Helper()
	st, err := store.Open(filepath.Join(t.TempDir(), "messages.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { st.Close() })
	return gateway.New(gateway.Config{Resolver: r, Store: st, Log: slog.New(slog.NewTextHandler(io.Discard, nil))})
}

var (
	alice = identity.Session{ID: "id-alice", Name: "alice"}
	bob   = identity.Session{ID: "id-bob", Name: "bob"}
)

// start runs serve on the listeners in the background; the test ends it by cancelling its context.
func start(t *testing.T, gw *gateway.Gateway, sessions, operator net.Listener) (cancel func(), done <-chan error) {
	t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	result := make(chan error, 1)
	go func() { result <- serve(ctx, slog.New(slog.NewTextHandler(io.Discard, nil)), gw, sessions, operator) }()
	return cancel, result
}

// returned waits for what serve returns.
func returned(t *testing.T, done <-chan error) error {
	t.Helper()
	select {
	case err := <-done:
		return err
	case <-time.After(5 * time.Second):
		t.Fatal("serve did not return")
		return nil
	}
}

const whoamiRequest = `{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"whoami","arguments":{}}}`

// whoami asks the gateway at base who is calling.
func whoami(t *testing.T, client *http.Client, base string) (int, string) {
	t.Helper()
	req, err := http.NewRequest(http.MethodPost, base+sessionapi.Path, strings.NewReader(whoamiRequest))
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json, text/event-stream")
	resp, err := client.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	return resp.StatusCode, string(body)
}

func whoamiOver(t *testing.T, l net.Listener) (int, string) {
	t.Helper()
	return whoami(t, http.DefaultClient, "http://"+l.Addr().String())
}

func TestServeNamesCallersByTheirVsockPeer(t *testing.T) {
	sessions, operator := listen(t), listen(t)
	cancel, done := start(t, newGateway(t, resolver{42: alice}), vmListener{Listener: sessions, cid: 42}, operator)

	status, body := whoamiOver(t, sessions)
	if status != http.StatusOK || !strings.Contains(body, `"name":"alice"`) {
		t.Fatalf("whoami from context ID 42 got %d %s, want alice", status, body)
	}

	resp, err := http.Get("http://" + operator.Addr().String() + "/threads")
	if err != nil {
		t.Fatal(err)
	}
	threads, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK || strings.TrimSpace(string(threads)) != "[]" {
		t.Errorf("the operator socket answered %d %s, want an empty list of threads", resp.StatusCode, threads)
	}

	cancel()
	if err := returned(t, done); err != nil {
		t.Errorf("serve returned %v after a shutdown it was asked for", err)
	}
	if c, err := net.Dial("tcp", sessions.Addr().String()); err == nil {
		c.Close()
		t.Error("the sessions socket still accepts connections after shutdown")
	}
	if c, err := net.Dial("tcp", operator.Addr().String()); err == nil {
		c.Close()
		t.Error("the operator socket still accepts connections after shutdown")
	}
}

// A request that announces a body and stops sending it ends when the server's read time runs out.
func TestSessionsServerEndsAStalledRequest(t *testing.T) {
	sessions := listen(t)
	srv := newSessionsServer(newGateway(t, resolver{42: alice}), stdlog.New(io.Discard, "", 0))
	if srv.ReadTimeout <= 0 || srv.WriteTimeout <= 0 {
		t.Fatalf("the sessions server has read time %v and write time %v, want both bounded", srv.ReadTimeout, srv.WriteTimeout)
	}
	srv.ReadTimeout = 200 * time.Millisecond
	go srv.Serve(vmListener{Listener: sessions, cid: 42})
	t.Cleanup(func() { srv.Close() })

	conn, err := net.Dial("tcp", sessions.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	fmt.Fprintf(conn, "POST %s HTTP/1.1\r\nHost: %s\r\nContent-Type: application/json\r\nAccept: application/json, text/event-stream\r\n"+
		"Content-Length: 1024\r\n\r\n{\"jsonrpc\"", sessionapi.Path, sessions.Addr())
	conn.SetReadDeadline(time.Now().Add(5 * time.Second))
	if _, err := io.Copy(io.Discard, conn); err != nil {
		t.Fatalf("the server kept a stalled request open: %v", err)
	}
}

// whoamiOnce asks who is calling on a new connection to l, and returns status 0 when the connection closes unanswered.
func whoamiOnce(t *testing.T, l net.Listener) (int, string) {
	t.Helper()
	conn, err := net.Dial("tcp", l.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	conn.SetDeadline(time.Now().Add(5 * time.Second))
	req, err := http.NewRequest(http.MethodPost, "http://"+l.Addr().String()+sessionapi.Path, strings.NewReader(whoamiRequest))
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json, text/event-stream")
	if err := req.Write(conn); err != nil {
		return 0, ""
	}
	resp, err := http.ReadResponse(bufio.NewReader(conn), req)
	if err != nil {
		return 0, ""
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	return resp.StatusCode, string(body)
}

func TestSessionsServerCapsTheConnectionsOfEachVM(t *testing.T) {
	srv := newSessionsServer(newGateway(t, resolver{42: alice, 43: bob}), stdlog.New(io.Discard, "", 0))
	full, other := listen(t), listen(t)
	go srv.Serve(vmListener{Listener: full, cid: 42})
	go srv.Serve(vmListener{Listener: other, cid: 43})
	t.Cleanup(func() { srv.Close() })

	// VM 42 holds every connection it may, idle.
	held := make([]net.Conn, maxPeerConns)
	for i := range held {
		c, err := net.Dial("tcp", full.Addr().String())
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { c.Close() })
		held[i] = c
	}
	if status, body := whoamiOnce(t, full); status != 0 {
		t.Errorf("a connection past VM 42's cap got %d %s, want it closed unanswered", status, body)
	}
	if status, body := whoamiOnce(t, other); status != http.StatusOK || !strings.Contains(body, `"name":"bob"`) {
		t.Errorf("VM 43 got %d %s, want bob", status, body)
	}

	// Closing a connection frees its place once the server sees it close.
	held[0].Close()
	deadline := time.Now().Add(5 * time.Second)
	for {
		status, body := whoamiOnce(t, full)
		if status == http.StatusOK && strings.Contains(body, `"name":"alice"`) {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("VM 42 got %d %s after closing a connection, want alice", status, body)
		}
		time.Sleep(10 * time.Millisecond)
	}
}

func TestServeRefusesConnectionsWithoutAVsockPeer(t *testing.T) {
	sessions, operator := listen(t), listen(t)
	start(t, newGateway(t, resolver{42: alice}), sessions, operator)
	if status, body := whoamiOver(t, sessions); status != http.StatusForbidden {
		t.Errorf("a connection that is not from a VM got %d %s, want 403", status, body)
	}
}

func TestServeRefusesVMsWithoutASession(t *testing.T) {
	sessions, operator := listen(t), listen(t)
	start(t, newGateway(t, resolver{42: alice}), vmListener{Listener: sessions, cid: 7}, operator)
	if status, body := whoamiOver(t, sessions); status != http.StatusForbidden {
		t.Errorf("a VM without a session got %d %s, want 403", status, body)
	}
}

func TestServeStopsWhenASocketFails(t *testing.T) {
	sessions, operator := listen(t), listen(t)
	sessions.Close()
	_, done := start(t, newGateway(t, resolver{42: alice}), sessions, operator)

	err := returned(t, done)
	if err == nil || !strings.Contains(err.Error(), "sessions") {
		t.Fatalf("serve returned %v, want the failure of the sessions socket", err)
	}
	if c, err := net.Dial("tcp", operator.Addr().String()); err == nil {
		c.Close()
		t.Error("the operator socket keeps serving after the sessions socket failed")
	}
}

// A connection accepted from a real AF_VSOCK socket reports its peer as a *vsock.Addr. The kernel's vsock loopback
// supplies one whose peer is vsock.Local, and the test skips where that is unavailable.
func TestServeOverVsockLoopback(t *testing.T) {
	sessions, err := vsock.ListenContextID(vsock.Local, 0, nil)
	if err != nil {
		t.Skipf("vsock loopback is unavailable: %v", err)
	}
	t.Cleanup(func() { sessions.Close() })
	port := sessions.Addr().(*vsock.Addr).Port
	dial := func(context.Context, string, string) (net.Conn, error) { return vsock.Dial(vsock.Local, port, nil) }

	probed := make(chan error, 1)
	go func() {
		c, err := dial(context.Background(), "", "")
		if err == nil {
			c.Close()
		}
		probed <- err
	}()
	select {
	case err := <-probed:
		if err != nil {
			t.Skipf("vsock loopback is unavailable: %v", err)
		}
	case <-time.After(3 * time.Second):
		t.Skip("vsock loopback does not connect")
	}

	start(t, newGateway(t, resolver{vsock.Local: alice}), sessions, listen(t))
	client := &http.Client{Timeout: 10 * time.Second, Transport: &http.Transport{DialContext: dial}}
	status, body := whoami(t, client, "http://gateway")
	if status != http.StatusOK || !strings.Contains(body, `"name":"alice"`) {
		t.Errorf("whoami over vsock got %d %s, want alice", status, body)
	}
}
