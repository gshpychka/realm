package main

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"sync"
	"sync/atomic"

	"github.com/gshpychka/realm/packages/bay/internal/fault"
)

const (
	codeInternalError = -32603
	methodInitialize  = "initialize"
)

// proxy relays JSON-RPC messages to the gateway and writes each response to out as one line.
type proxy struct {
	client *http.Client
	log    *slog.Logger

	out   io.Writer
	outMu sync.Mutex

	// version is the protocol version the gateway negotiated at initialize.
	version atomic.Value
}

// message is the part of a JSON-RPC message the proxy reads.
type message struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id"`
	Method  string          `json:"method"`
}

// isCall reports whether m is a request that expects a response.
func (m message) isCall() bool {
	return m.Method != "" && len(m.ID) > 0
}

// mcp serves the gateway's tools as an MCP server on standard input and output.
func (a *app) mcp(ctx context.Context, args []string) error {
	if len(args) != 0 {
		return fmt.Errorf("%w: mcp takes no arguments", fault.Invalid)
	}
	p := &proxy{client: a.gateway.client(), log: slog.New(slog.NewTextHandler(a.stderr, nil)), out: a.stdout}
	return p.serve(ctx, a.stdin)
}

// serve relays every line of in, concurrently, until in ends and every request has been answered.
func (p *proxy) serve(ctx context.Context, in io.Reader) error {
	var wg sync.WaitGroup
	defer wg.Wait()
	r := bufio.NewReader(in)
	for {
		line, err := r.ReadBytes('\n')
		if line = bytes.TrimSpace(line); len(line) > 0 {
			wg.Go(func() { p.relay(ctx, line) })
		}
		if errors.Is(err, io.EOF) {
			return nil
		}
		if err != nil {
			return fmt.Errorf("read standard input: %w", err)
		}
	}
}

// relay posts one message to the gateway and writes its response. A call always gets a response, the gateway's or an
// error that names what failed.
func (p *proxy) relay(ctx context.Context, line []byte) {
	var m message
	if err := json.Unmarshal(line, &m); err != nil {
		p.log.Warn("skipping a line that is not a single JSON-RPC message", "err", err)
		return
	}
	response, err := p.post(ctx, line, m.Method)
	if err == nil && response == nil && m.isCall() {
		err = errors.New("no response")
	}
	if err != nil {
		p.log.Warn("gateway request failed", "method", m.Method, "err", err)
		if m.isCall() {
			p.write(errorResponse(m.ID, err))
		}
		return
	}
	if response == nil {
		return
	}
	if m.Method == methodInitialize {
		// Stored before the write, since the program may send its next request as soon as it reads this response.
		p.learnVersion(response)
	}
	p.write(response)
}

// post sends line to the gateway and returns its response as one line, or nil when the gateway accepted the message
// without answering.
func (p *proxy) post(ctx context.Context, line []byte, method string) ([]byte, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(line))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	// Streamable HTTP requires both media types on every POST:
	// https://modelcontextprotocol.io/specification/2025-11-25/basic/transports#sending-messages-to-the-server
	req.Header.Set("Accept", "application/json, text/event-stream")
	if v, _ := p.version.Load().(string); v != "" && method != methodInitialize {
		req.Header.Set("MCP-Protocol-Version", v)
	}
	resp, err := p.client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, err
	}

	var response bytes.Buffer
	if json.Compact(&response, body) == nil && isJSONRPC(response.Bytes()) {
		return response.Bytes(), nil
	}
	if resp.StatusCode/100 == 2 && len(bytes.TrimSpace(body)) == 0 {
		return nil, nil
	}
	return nil, statusError(resp, body)
}

func isJSONRPC(line []byte) bool {
	var m message
	return json.Unmarshal(line, &m) == nil && m.JSONRPC == "2.0"
}

// statusError describes a reply that carries no JSON-RPC message by its status and the first line of its body.
func statusError(resp *http.Response, body []byte) error {
	reason, _, _ := bytes.Cut(bytes.TrimSpace(body), []byte("\n"))
	if len(reason) == 0 {
		return errors.New(resp.Status)
	}
	return fmt.Errorf("%s: %.200s", resp.Status, reason)
}

func (p *proxy) learnVersion(response []byte) {
	var initialized struct {
		Result struct {
			ProtocolVersion string `json:"protocolVersion"`
		} `json:"result"`
	}
	if json.Unmarshal(response, &initialized) == nil && initialized.Result.ProtocolVersion != "" {
		p.version.Store(initialized.Result.ProtocolVersion)
	}
}

func (p *proxy) write(line []byte) {
	p.outMu.Lock()
	defer p.outMu.Unlock()
	if _, err := p.out.Write(append(line, '\n')); err != nil {
		p.log.Error("write to standard output failed", "err", err)
	}
}

func errorResponse(id json.RawMessage, err error) []byte {
	line, _ := json.Marshal(map[string]any{
		"jsonrpc": "2.0",
		"id":      id,
		"error":   map[string]any{"code": codeInternalError, "message": "gateway: " + err.Error()},
	})
	return line
}
