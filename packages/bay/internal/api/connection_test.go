package api

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/gshpychka/realm/packages/bay/internal/fault"
	"github.com/gshpychka/realm/packages/bay/internal/identity"
)

type connectionService struct {
	Service
	open func(context.Context, string, string) (io.ReadWriteCloser, error)
}

func (s connectionService) Connect(ctx context.Context, name, id string, generation ...uint64) (io.ReadWriteCloser, error) {
	return s.open(ctx, name, id)
}

func (s connectionService) Environment(ctx context.Context, name string, expected identity.Precondition, _ string) (io.ReadWriteCloser, error) {
	return s.open(ctx, name, expected.ID)
}

func connectionClient(t *testing.T, open func(context.Context, string, string) (io.ReadWriteCloser, error)) *Client {
	t.Helper()
	socket := filepath.Join(t.TempDir(), "bay.sock")
	listener, err := net.Listen("unix", socket)
	if err != nil {
		t.Fatal(err)
	}
	server := httptest.NewUnstartedServer(Handler(connectionService{open: open}, http.NotFoundHandler()))
	server.Listener.Close()
	server.Listener = listener
	server.Start()
	t.Cleanup(server.Close)
	return NewClient(socket)
}

type testConnection struct {
	input  *io.PipeWriter
	output *io.PipeReader
}

func (c *testConnection) Read(p []byte) (int, error)  { return c.output.Read(p) }
func (c *testConnection) Write(p []byte) (int, error) { return c.input.Write(p) }
func (c *testConnection) CloseWrite() error           { return c.input.Close() }
func (c *testConnection) Close() error {
	c.input.Close()
	c.output.Close()
	return nil
}

func TestConnectionIsDuplexBeforeInputEnds(t *testing.T) {
	client := connectionClient(t, func(_ context.Context, name, id string) (io.ReadWriteCloser, error) {
		if name != "one" || id != "id-one" {
			return nil, fmt.Errorf("unexpected identity %s %s", name, id)
		}
		in, input := io.Pipe()
		output, out := io.Pipe()
		go func() {
			defer in.Close()
			defer out.Close()
			if _, err := io.Copy(out, in); err == nil {
				io.WriteString(out, "finished")
			}
		}()
		return &testConnection{input: input, output: output}, nil
	})
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	c, err := client.Connect(ctx, "one", "id-one")
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	// This must arrive before EOF on the request; a buffered HTTP exchange would
	// deadlock waiting for the rest of the operator's input.
	message := "hello\x00\n"
	if _, err := io.WriteString(c, message); err != nil {
		t.Fatal(err)
	}
	data := make([]byte, len(message))
	if _, err := io.ReadFull(c, data); err != nil || string(data) != message {
		t.Fatalf("stream read %q, %v", data, err)
	}
	if err := c.CloseWrite(); err != nil {
		t.Fatal(err)
	}
	rest, err := io.ReadAll(c)
	if err != nil || string(rest) != "finished" {
		t.Fatalf("response after input EOF = %q, %v", rest, err)
	}
}

func TestConnectionRequiresIdentityBeforeOpeningBridge(t *testing.T) {
	var calls atomic.Int32
	client := connectionClient(t, func(_ context.Context, _, _ string) (io.ReadWriteCloser, error) {
		calls.Add(1)
		return nil, fmt.Errorf("%w: stale identity", fault.Conflict)
	})
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_, err := client.Connect(ctx, "one", "")
	if !errors.Is(err, fault.Invalid) || calls.Load() != 0 {
		t.Fatalf("missing identity = %v, %d bridge calls", err, calls.Load())
	}
	_, err = client.Connect(ctx, "one", "stale")
	if !errors.Is(err, fault.Conflict) || calls.Load() != 1 {
		t.Fatalf("stale identity = %v, %d bridge calls", err, calls.Load())
	}
}

func TestBridgeFailureDoesNotCorruptProgramBytes(t *testing.T) {
	client := connectionClient(t, func(_ context.Context, _, _ string) (io.ReadWriteCloser, error) {
		_, input := io.Pipe()
		output, out := io.Pipe()
		go func() {
			io.WriteString(out, "program output")
			out.CloseWithError(errors.New("bridge failed"))
		}()
		return &testConnection{input: input, output: output}, nil
	})
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	c, err := client.Connect(ctx, "one", "id-one")
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	data, err := io.ReadAll(c)
	if string(data) != "program output" || err == nil || !strings.Contains(err.Error(), "connection failed") {
		t.Fatalf("failed bridge returned %q, %v", data, err)
	}
}

func TestEnvironmentRejectsStaleIdentityBeforeInputEnds(t *testing.T) {
	client := connectionClient(t, func(_ context.Context, _, _ string) (io.ReadWriteCloser, error) {
		return nil, fmt.Errorf("%w: stale execution", fault.Conflict)
	})
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	generation := uint64(3)
	_, err := client.Environment(ctx, "one", identity.Precondition{ID: "stale", Generation: &generation}, "machine-revision")
	if !errors.Is(err, fault.Conflict) {
		t.Fatalf("stale environment handshake waited for input instead of rejecting: %v", err)
	}
}
