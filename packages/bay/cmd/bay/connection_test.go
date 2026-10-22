package main

import (
	"io"
	"strings"
	"testing"
)

type pipeConnection struct {
	*io.PipeReader
	input *io.PipeWriter
}

func (p *pipeConnection) Write(b []byte) (int, error) { return p.input.Write(b) }
func (p *pipeConnection) CloseWrite() error           { return p.input.Close() }
func (p *pipeConnection) Close() error {
	p.input.Close()
	return p.PipeReader.Close()
}

func TestConnectStreamsAndDrainsAfterStdinEOF(t *testing.T) {
	h := newHarness(t)
	h.svc.connect = func() io.ReadWriteCloser {
		in, input := io.Pipe()
		output, out := io.Pipe()
		go func() {
			defer out.Close()
			defer in.Close()
			data, err := io.ReadAll(in)
			if err == nil {
				io.WriteString(out, "reply "+string(data))
			}
		}()
		return &pipeConnection{PipeReader: output, input: input}
	}
	got := h.run("hello\x00\n", "connect", "one", "--id", "id-one")
	if got.code != 0 || got.stdout != "reply hello\x00\n" || got.stderr != "" {
		t.Fatalf("connect = %+v", got)
	}
	if len(h.svc.calls) != 1 || h.svc.calls[0] != "Connect one id-one" {
		t.Fatalf("connection calls = %q", h.svc.calls)
	}
}

func TestConnectRequiresExplicitIdentity(t *testing.T) {
	h := newHarness(t)
	got := h.run("", "connect", "one")
	if got.code != 2 || !strings.Contains(got.stderr, "--id") || len(h.svc.calls) != 0 {
		t.Fatalf("connect without identity = %+v, calls %q", got, h.svc.calls)
	}
}

func TestConnectForwardsExplicitExecutionGeneration(t *testing.T) {
	h := newHarness(t)
	h.svc.connect = func() io.ReadWriteCloser {
		in, input := io.Pipe()
		output, out := io.Pipe()
		go func() { io.Copy(io.Discard, in); in.Close(); out.Close() }()
		return &pipeConnection{PipeReader: output, input: input}
	}
	got := h.run("", "connect", "one", "--id", "id-one", "--generation", "0")
	if got.code != 0 || len(h.svc.gotGeneration) != 1 || h.svc.gotGeneration[0] != 0 {
		t.Fatalf("fenced connect = %+v, generations %v", got, h.svc.gotGeneration)
	}
}
