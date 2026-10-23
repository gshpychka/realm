package main

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gshpychka/realm/packages/bay/internal/sessionapi"
	"github.com/modelcontextprotocol/go-sdk/mcp"
)

const patience = 5 * time.Second

// program drives flare mcp the way a session's program does: lines in, lines out.
type program struct {
	t      *testing.T
	in     *io.PipeWriter
	lines  chan string
	exit   chan int
	stderr bytes.Buffer // read only after exit
}

// startProgram runs flare mcp against the gateway reached through dial, with the given request timeout.
func startProgram(t *testing.T, dial dialFunc, timeout time.Duration) *program {
	t.Helper()
	inR, inW := io.Pipe()
	outR, outW := io.Pipe()
	prog := &program{t: t, in: inW, lines: make(chan string, 64), exit: make(chan int, 1)}
	t.Cleanup(func() { inW.Close() })

	go func() {
		defer close(prog.lines)
		scanner := bufio.NewScanner(outR)
		scanner.Buffer(nil, 8<<20)
		for scanner.Scan() {
			prog.lines <- scanner.Text()
		}
	}()
	a := &app{stdin: inR, stdout: outW, stderr: &prog.stderr, gateway: gateway{dial: dial, timeout: timeout}}
	go func() {
		code := a.run(context.Background(), []string{"mcp"})
		outW.Close()
		prog.exit <- code
	}()
	return prog
}

func (prog *program) send(line string) {
	prog.t.Helper()
	written := make(chan error, 1)
	go func() {
		_, err := io.WriteString(prog.in, line+"\n")
		written <- err
	}()
	select {
	case err := <-written:
		if err != nil {
			prog.t.Fatalf("write to flare mcp: %v", err)
		}
	case <-time.After(patience):
		prog.t.Fatal("flare mcp stopped reading its input")
	}
}

// next returns the next line flare mcp wrote.
func (prog *program) next() string {
	prog.t.Helper()
	select {
	case line, ok := <-prog.lines:
		if !ok {
			prog.t.Fatal("flare mcp ended its output")
		}
		return line
	case <-time.After(patience):
		prog.t.Fatal("flare mcp wrote no response")
	}
	return ""
}

// finish ends the program's input and waits for flare mcp to exit.
func (prog *program) finish() {
	prog.t.Helper()
	prog.in.Close()
	prog.wait()
}

// wait waits for flare mcp to exit with code 0, having written nothing the program did not read.
func (prog *program) wait() {
	prog.t.Helper()
	select {
	case code := <-prog.exit:
		if code != 0 {
			prog.t.Fatalf("flare mcp exited with %d", code)
		}
		if extra, ok := <-prog.lines; ok {
			prog.t.Fatalf("flare mcp wrote an unexpected line: %s", extra)
		}
	case <-time.After(patience):
		prog.t.Fatal("flare mcp did not exit")
	}
}

// response is a JSON-RPC response as the tests read it.
type response struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id"`
	Result  json.RawMessage `json:"result"`
	Error   *struct {
		Code    int    `json:"code"`
		Message string `json:"message"`
	} `json:"error"`
}

func parse(t *testing.T, line string) response {
	t.Helper()
	var r response
	if err := json.Unmarshal([]byte(line), &r); err != nil {
		t.Fatalf("flare mcp wrote %q, which is not JSON: %v", line, err)
	}
	return r
}

func callTool(id any, tool string, arguments string) string {
	return fmt.Sprintf(`{"jsonrpc":"2.0","id":%v,"method":"tools/call","params":{"name":%q,"arguments":%s}}`, id, tool, arguments)
}

func TestProxyRelaysAProgramSession(t *testing.T) {
	s := newStub(t)
	prog := startProgram(t, s.dial, 0)

	prog.send(`{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"program","version":"1"}}}`)
	init := parse(t, prog.next())
	var negotiated struct{ ProtocolVersion string }
	if err := json.Unmarshal(init.Result, &negotiated); err != nil || string(init.ID) != "1" || negotiated.ProtocolVersion != "2025-06-18" {
		t.Fatalf("initialize answered with id %s and result %s", init.ID, init.Result)
	}

	// The notification gets no line; the next line read is the response to the call after it.
	prog.send(`{"jsonrpc":"2.0","method":"notifications/initialized"}`)
	prog.send(`{"jsonrpc":"2.0","id":"list","method":"tools/list"}`)
	list := parse(t, prog.next())
	if string(list.ID) != `"list"` || list.Error != nil {
		t.Fatalf("tools/list answered with id %s and error %v", list.ID, list.Error)
	}
	var tools struct{ Tools []struct{ Name string } }
	if err := json.Unmarshal(list.Result, &tools); err != nil || len(tools.Tools) != 5 {
		t.Fatalf("tools/list returned %s", list.Result)
	}

	prog.send(callTool(3, sessionapi.Whoami, `{}`))
	whoami := parse(t, prog.next())
	var result struct{ StructuredContent sessionapi.WhoamiOutput }
	if err := json.Unmarshal(whoami.Result, &result); err != nil || string(whoami.ID) != "3" || result.StructuredContent.Name != "alpha" {
		t.Fatalf("whoami answered with id %s and result %s", whoami.ID, whoami.Result)
	}

	prog.finish()

	if len(s.requests) != 4 || s.dials != 4 {
		t.Fatalf("gateway received %d requests over %d dials, want 4 and 4", len(s.requests), s.dials)
	}
	remotes := map[string]bool{}
	for _, r := range s.requests {
		remotes[r.remote] = true
		if got := r.header.Get("Content-Type"); got != "application/json" {
			t.Errorf("%s was sent as %q", r.method, got)
		}
		accept := r.header.Get("Accept")
		if !strings.Contains(accept, "application/json") || !strings.Contains(accept, "text/event-stream") {
			t.Errorf("%s was sent with Accept %q", r.method, accept)
		}
		want := "2025-06-18"
		if r.method == "initialize" {
			want = ""
		}
		if got := r.header.Get("MCP-Protocol-Version"); got != want {
			t.Errorf("%s was sent with MCP-Protocol-Version %q, want %q", r.method, got, want)
		}
	}
	if len(remotes) != 4 {
		t.Errorf("requests shared connections: %d connections for 4 requests", len(remotes))
	}
}

func TestProxyHandlesRequestsConcurrently(t *testing.T) {
	s := newStub(t)
	release := s.holdWhoami(t)
	prog := startProgram(t, s.dial, 0)

	prog.send(callTool(1, sessionapi.Whoami, `{}`))
	prog.send(callTool(2, sessionapi.Inbox, `{}`))
	if got := parse(t, prog.next()); string(got.ID) != "2" {
		t.Fatalf("the first response is for id %s, want the call that was not held", got.ID)
	}

	// The held call is in flight when the input ends.
	prog.in.Close()
	select {
	case <-prog.exit:
		t.Fatal("flare mcp exited with a call in flight")
	case <-time.After(100 * time.Millisecond):
	}
	release()
	if got := parse(t, prog.next()); string(got.ID) != "1" {
		t.Fatalf("the last response is for id %s, want 1", got.ID)
	}
	prog.wait()
}

func TestProxyServesAnMCPClient(t *testing.T) {
	s := newStub(t)
	toProxyR, toProxyW := io.Pipe()
	fromProxyR, fromProxyW := io.Pipe()
	a := &app{stdin: toProxyR, stdout: fromProxyW, stderr: io.Discard, gateway: gateway{dial: s.dial}}
	exit := make(chan int, 1)
	go func() {
		exit <- a.run(context.Background(), []string{"mcp"})
		fromProxyW.Close()
	}()

	ctx, cancel := context.WithTimeout(context.Background(), patience)
	defer cancel()
	client := mcp.NewClient(&mcp.Implementation{Name: "program", Version: "1"}, nil)
	session, err := client.Connect(ctx, &mcp.IOTransport{Reader: fromProxyR, Writer: toProxyW}, nil)
	if err != nil {
		t.Fatalf("connect through flare mcp: %v", err)
	}
	tools, err := session.ListTools(ctx, nil)
	if err != nil || len(tools.Tools) != 5 {
		t.Fatalf("ListTools returned %+v, %v", tools, err)
	}
	res, err := session.CallTool(ctx, &mcp.CallToolParams{Name: sessionapi.Whoami})
	if err != nil || res.IsError {
		t.Fatalf("whoami returned %+v, %v", res, err)
	}
	encoded, err := json.Marshal(res.StructuredContent)
	if err != nil {
		t.Fatal(err)
	}
	var who sessionapi.WhoamiOutput
	if err := json.Unmarshal(encoded, &who); err != nil || who != (sessionapi.WhoamiOutput{Name: "alpha", ID: "id-alpha", Generation: 1}) {
		t.Fatalf("whoami identity = %+v, %v", who, err)
	}
	res, err = session.CallTool(ctx, &mcp.CallToolParams{Name: sessionapi.Send, Arguments: sessionapi.SendInput{To: "ghost", Body: "hi"}})
	if err != nil || !res.IsError || !strings.Contains(res.Content[0].(*mcp.TextContent).Text, "not found") {
		t.Fatalf("send to a ghost returned %+v, %v", res, err)
	}
	session.Close()
	select {
	case code := <-exit:
		if code != 0 {
			t.Fatalf("flare mcp exited with %d", code)
		}
	case <-time.After(patience):
		t.Fatal("flare mcp did not exit after the client closed")
	}
}

func TestProxyNegotiatesAgainOnEveryInitialize(t *testing.T) {
	s := newStub(t)
	prog := startProgram(t, s.dial, 0)

	initialize := func(id int, version string) string {
		return fmt.Sprintf(`{"jsonrpc":"2.0","id":%d,"method":"initialize","params":{"protocolVersion":%q,"capabilities":{},"clientInfo":{"name":"program","version":"1"}}}`, id, version)
	}
	prog.send(initialize(1, "2025-06-18"))
	prog.next()
	prog.send(initialize(2, "2025-03-26"))
	prog.next()
	prog.send(`{"jsonrpc":"2.0","id":3,"method":"ping"}`)
	prog.next()
	prog.finish()

	want := []string{"", "", "2025-03-26"}
	if len(s.requests) != len(want) {
		t.Fatalf("gateway received %d requests, want %d", len(s.requests), len(want))
	}
	for i, r := range s.requests {
		if got := r.header.Get("MCP-Protocol-Version"); got != want[i] {
			t.Errorf("request %d (%s) carried MCP-Protocol-Version %q, want %q", i+1, r.method, got, want[i])
		}
	}
}

func TestProxyEndsARequestTheGatewayNeverAnswers(t *testing.T) {
	srv := httptest.NewServer(hang())
	defer srv.Close()
	prog := startProgram(t, dialTo(srv), 100*time.Millisecond)

	prog.send(callTool(1, sessionapi.Whoami, `{}`))
	if got := parse(t, prog.next()); string(got.ID) != "1" || got.Error == nil || !strings.Contains(got.Error.Message, "Timeout") {
		t.Fatalf("flare mcp answered %+v (error %+v), want a timeout error for id 1", got, got.Error)
	}
	prog.finish()
}

func TestProxyAnswersACallWhenTheGatewayIsUnreachable(t *testing.T) {
	prog := startProgram(t, refuse, 0)

	// An ID beyond float64 precision comes back as sent.
	prog.send(callTool("12345678901234567890", sessionapi.Send, `{"to":"beta","body":"S3CRET"}`))
	got := parse(t, prog.next())
	if string(got.ID) != "12345678901234567890" || got.JSONRPC != "2.0" || got.Error == nil ||
		got.Error.Code != codeInternalError || !strings.Contains(got.Error.Message, "connection refused") {
		t.Fatalf("flare mcp answered %+v (error %+v)", got, got.Error)
	}

	prog.send(`{"jsonrpc":"2.0","method":"notifications/initialized"}`)
	prog.finish()
	log := prog.stderr.String()
	if !strings.Contains(log, "gateway request failed") || !strings.Contains(log, "notifications/initialized") {
		t.Fatalf("flare mcp logged %q, want both failures", log)
	}
	if strings.Contains(log, "S3CRET") || strings.Contains(got.Error.Message, "S3CRET") {
		t.Fatalf("flare mcp reported a message body: %q, %q", log, got.Error.Message)
	}
}

func TestProxyTurnsGatewayRepliesIntoResponses(t *testing.T) {
	const rpcError = `{"jsonrpc":"2.0","id":9,"error":{"code":-32602,"message":"bad params"}}`
	tests := []struct {
		name  string
		reply func(w http.ResponseWriter)
		line  string // the exact response line, when the reply is relayed
		fail  string // a substring of the error flare mcp reports otherwise
	}{
		{
			name: "response",
			reply: func(w http.ResponseWriter) {
				w.Header().Set("Content-Type", "application/json")
				io.WriteString(w, "{\n  \"jsonrpc\": \"2.0\",\n  \"id\": 9,\n  \"result\": {\"a\": \"b\\nc\"}\n}\n")
			},
			line: `{"jsonrpc":"2.0","id":9,"result":{"a":"b\nc"}}`,
		},
		{
			name: "JSON-RPC error with an error status",
			reply: func(w http.ResponseWriter) {
				w.Header().Set("Content-Type", "application/json")
				w.WriteHeader(http.StatusBadRequest)
				io.WriteString(w, rpcError)
			},
			line: rpcError,
		},
		{
			name:  "plain text error",
			reply: func(w http.ResponseWriter) { http.Error(w, "Bad Request: no such protocol", http.StatusBadRequest) },
			fail:  "400 Bad Request: Bad Request: no such protocol",
		},
		{
			name: "JSON that is not a JSON-RPC message",
			reply: func(w http.ResponseWriter) {
				w.Header().Set("Content-Type", "application/json")
				w.WriteHeader(http.StatusForbidden)
				io.WriteString(w, `{"error":"forbidden: no such session"}`)
			},
			fail: "403 Forbidden: " + `{"error":"forbidden: no such session"}`,
		},
		{
			name: "event stream",
			reply: func(w http.ResponseWriter) {
				w.Header().Set("Content-Type", "text/event-stream")
				io.WriteString(w, "event: message\ndata: {\"jsonrpc\":\"2.0\",\"id\":9,\"result\":{\"body\":\"S3CRET\"}}\n\n")
			},
			fail: "200 OK: event: message",
		},
		{
			name:  "accepted without a response",
			reply: func(w http.ResponseWriter) { w.WriteHeader(http.StatusAccepted) },
			fail:  "no response",
		},
		{
			name:  "error status without a body",
			reply: func(w http.ResponseWriter) { w.WriteHeader(http.StatusServiceUnavailable) },
			fail:  "503 Service Unavailable",
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { tt.reply(w) }))
			defer srv.Close()
			prog := startProgram(t, dialTo(srv), 0)

			prog.send(`{"jsonrpc":"2.0","id":9,"method":"ping"}`)
			line := prog.next()
			if tt.line != "" {
				if line != tt.line {
					t.Fatalf("flare mcp wrote %s, want %s", line, tt.line)
				}
			} else {
				got := parse(t, line)
				if strings.Contains(line, "S3CRET") {
					t.Fatalf("flare mcp wrote beyond the first line of the reply: %s", line)
				}
				if string(got.ID) != "9" || got.Error == nil || got.Error.Code != codeInternalError || !strings.Contains(got.Error.Message, tt.fail) {
					t.Fatalf("flare mcp wrote %s, want an error with id 9 containing %q", line, tt.fail)
				}
			}
			prog.finish()
		})
	}
}

func TestProxyIgnoresLinesThatAreNotMessages(t *testing.T) {
	s := newStub(t)
	prog := startProgram(t, s.dial, 0)

	for _, line := range []string{"", "  ", "not json", `[{"jsonrpc":"2.0","id":1,"method":"ping"}]`} {
		prog.send(line)
	}
	prog.send(`{"jsonrpc":"2.0","id":2,"method":"ping"}`)
	if got := parse(t, prog.next()); string(got.ID) != "2" || got.Error != nil {
		t.Fatalf("ping answered with %+v", got)
	}
	prog.finish()
	if len(s.requests) != 1 {
		t.Fatalf("gateway received %d requests, want only the ping", len(s.requests))
	}
	if n := strings.Count(prog.stderr.String(), "skipping a line"); n != 2 {
		t.Fatalf("flare mcp logged %d skipped lines, want 2 (not blank lines):\n%s", n, prog.stderr.String())
	}
}

func TestProxyRelaysALastLineWithoutNewline(t *testing.T) {
	s := newStub(t)
	prog := startProgram(t, s.dial, 0)

	if _, err := io.WriteString(prog.in, `{"jsonrpc":"2.0","id":1,"method":"ping"}`); err != nil {
		t.Fatal(err)
	}
	prog.in.Close()
	if got := parse(t, prog.next()); string(got.ID) != "1" || got.Error != nil {
		t.Fatalf("ping answered with %+v", got)
	}
	prog.wait()
}

func TestProxyRelaysLargeMessages(t *testing.T) {
	s := newStub(t)
	prog := startProgram(t, s.dial, 0)

	body := strings.Repeat("x", 300_000)
	prog.send(callTool(1, sessionapi.Send, fmt.Sprintf(`{"to":"beta","body":%q}`, body)))
	if got := parse(t, prog.next()); got.Error != nil || string(got.ID) != "1" {
		t.Fatalf("send answered with %+v (error %+v)", got, got.Error)
	}
	prog.finish()
	if len(s.sends) != 1 || s.sends[0].Body != body {
		t.Fatalf("gateway received %d messages, want the %d byte body intact", len(s.sends), len(body))
	}
}
