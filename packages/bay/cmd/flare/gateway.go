package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/http"
	"strings"
	"time"

	"github.com/gshpychka/realm/packages/bay/internal/sessionapi"
	"github.com/mdlayher/vsock"
	"github.com/modelcontextprotocol/go-sdk/mcp"
)

const endpoint = "http://gateway" + sessionapi.Path

var version = "dev"

type dialFunc func(ctx context.Context, network, addr string) (net.Conn, error)

// dialGateway connects to the gateway on the host, whatever address it is asked for.
func dialGateway(context.Context, string, string) (net.Conn, error) {
	conn, err := vsock.Dial(vsock.Host, sessionapi.Port, nil)
	if err != nil {
		return nil, err
	}
	return conn, nil
}

// gateway is how flare reaches the gateway: a way to connect, and how long each request may take.
type gateway struct {
	dial dialFunc
	// timeout ends a request that takes longer; zero means no limit.
	timeout time.Duration
}

// client returns an HTTP client that sends every request to the gateway on a new connection.
func (g gateway) client() *http.Client {
	return &http.Client{
		Timeout: g.timeout,
		// Suspending a session breaks the connections it holds.
		Transport: &http.Transport{DialContext: g.dial, DisableKeepAlives: true},
	}
}

// call runs tool with in on the gateway and returns its output. A tool that fails is an error carrying the text it
// reported.
func call[Out any](ctx context.Context, g gateway, tool string, in any) (Out, error) {
	var out Out
	client := mcp.NewClient(&mcp.Implementation{Name: "flare", Version: version}, nil)
	session, err := client.Connect(ctx, &mcp.StreamableClientTransport{
		Endpoint:             endpoint,
		HTTPClient:           g.client(),
		DisableStandaloneSSE: true,
	}, nil)
	if err != nil {
		return out, fmt.Errorf("connect to the gateway: %w", err)
	}
	defer session.Close()

	res, err := session.CallTool(ctx, &mcp.CallToolParams{Name: tool, Arguments: in})
	if err != nil {
		return out, fmt.Errorf("%s: %w", tool, err)
	}
	if res.IsError {
		return out, toolFailure(tool, res)
	}
	if res.StructuredContent == nil {
		return out, fmt.Errorf("%s: the gateway returned no output", tool)
	}
	data, err := json.Marshal(res.StructuredContent)
	if err == nil {
		err = json.Unmarshal(data, &out)
	}
	if err != nil {
		return out, fmt.Errorf("%s: decode the output: %w", tool, err)
	}
	return out, nil
}

func toolFailure(tool string, res *mcp.CallToolResult) error {
	var texts []string
	for _, c := range res.Content {
		if t, ok := c.(*mcp.TextContent); ok {
			texts = append(texts, t.Text)
		}
	}
	if len(texts) == 0 {
		return fmt.Errorf("%s failed", tool)
	}
	return errors.New(strings.Join(texts, "\n"))
}
