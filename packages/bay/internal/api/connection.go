package api

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"time"

	"github.com/gshpychka/realm/packages/bay/internal/fault"
	"github.com/gshpychka/realm/packages/bay/internal/identity"
	"github.com/gshpychka/realm/packages/bay/internal/wire"
)

// SessionIDHeader binds a connection to a record, rather than a reusable name.
const SessionIDHeader = "Bay-Session-ID"

const SessionGenerationHeader = "Bay-Session-Generation"

// ConnectionErrorTrailer reports an unsuccessful bridge after streaming started.
// The byte stream itself belongs entirely to the program's protocol.
const ConnectionErrorTrailer = "Bay-Connection-Error"

// Connection is a program's byte stream, with independently closable input.
type Connection interface {
	io.ReadWriteCloser
	CloseWrite() error
}

func connectHandler(svc Service) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !prepareConnection(w) {
			return
		}
		ids := r.Header.Values(SessionIDHeader)
		if len(ids) != 1 || ids[0] == "" {
			wire.Fail(w, fmt.Errorf("%w: one %s is required", fault.Invalid, SessionIDHeader))
			return
		}
		id := ids[0]
		var generations []uint64
		if values, present := r.Header[http.CanonicalHeaderKey(SessionGenerationHeader)]; present {
			if len(values) != 1 {
				wire.Fail(w, fmt.Errorf("%w: one execution generation is required", fault.Invalid))
				return
			}
			n, err := strconv.ParseUint(values[0], 10, 64)
			if err != nil || n < 1 {
				wire.Fail(w, fmt.Errorf("%w: invalid execution generation", fault.Invalid))
				return
			}
			generations = []uint64{n}
		}
		connection, err := svc.Connect(r.Context(), r.PathValue("name"), id, generations...)
		if err != nil {
			wire.Fail(w, err)
			return
		}
		streamConnection(w, r, connection, id, generations)
	}
}

const MachineRevisionHeader = "Bay-Machine-Revision"

func environmentHandler(svc Service) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !prepareConnection(w) {
			return
		}
		ids, generations, revisions := r.Header.Values(SessionIDHeader), r.Header.Values(SessionGenerationHeader), r.Header.Values(MachineRevisionHeader)
		if len(ids) != 1 || ids[0] == "" || len(generations) != 1 || len(revisions) != 1 || revisions[0] == "" {
			wire.Fail(w, fmt.Errorf("%w: environment requires one record, generation and machine revision", fault.Invalid))
			return
		}
		generation, err := strconv.ParseUint(generations[0], 10, 64)
		if err != nil || generation < 1 {
			wire.Fail(w, fmt.Errorf("%w: invalid execution generation", fault.Invalid))
			return
		}
		connection, err := svc.Environment(r.Context(), r.PathValue("name"), identity.Precondition{ID: ids[0], Generation: &generation}, revisions[0])
		if err != nil {
			wire.Fail(w, err)
			return
		}
		w.Header().Set(MachineRevisionHeader, revisions[0])
		streamConnection(w, r, connection, ids[0], []uint64{generation})
	}
}

// A rejected stream must answer before the caller sends or closes its input.
// Without full duplex, net/http drains the body before writing even an error,
// while a streaming client waits for that response before sending its data.
func prepareConnection(w http.ResponseWriter) bool {
	w.Header().Set("Connection", "close")
	if err := http.NewResponseController(w).EnableFullDuplex(); err != nil {
		wire.Fail(w, err)
		return false
	}
	return true
}

func streamConnection(w http.ResponseWriter, r *http.Request, connection io.ReadWriteCloser, id string, generations []uint64) {
	control := http.NewResponseController(w)
	if err := control.EnableFullDuplex(); err != nil {
		connection.Close()
		wire.Fail(w, err)
		return
	}
	defer connection.Close()
	w.Header().Set("Content-Type", "application/octet-stream")
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Connection", "close")
	w.Header().Set(SessionIDHeader, id)
	if len(generations) > 0 {
		w.Header().Set(SessionGenerationHeader, strconv.FormatUint(generations[0], 10))
	}
	w.Header().Set("Trailer", ConnectionErrorTrailer)
	w.WriteHeader(http.StatusOK)
	if err := control.Flush(); err != nil {
		return
	}
	inputDone := make(chan struct{})
	go func() {
		defer close(inputDone)
		if _, err := io.Copy(connection, r.Body); err != nil {
			connection.Close()
		} else if half, ok := connection.(interface{ CloseWrite() error }); ok {
			half.CloseWrite()
		}
	}()
	_, err := io.Copy(flushedWriter{w, control}, connection)
	if err != nil && r.Context().Err() == nil {
		w.Header().Set(ConnectionErrorTrailer, "bridge-failed")
	}
	connection.Close()
	// A program can finish before its client closes input. Release both the
	// HTTP reader and a writer blocked by the program's backpressure.
	control.SetReadDeadline(time.Now())
	r.Body.Close()
	<-inputDone
}

type flushedWriter struct {
	w       io.Writer
	control *http.ResponseController
}

func (w flushedWriter) Write(p []byte) (int, error) {
	n, err := w.w.Write(p)
	if err == nil {
		err = w.control.Flush()
	}
	return n, err
}

// Connect opens a full-duplex byte stream to a configured program. CloseWrite
// finishes request input while retaining the response; Close disconnects both.
func (c *Client) Connect(ctx context.Context, name, id string, generation ...uint64) (Connection, error) {
	if id == "" {
		return nil, fmt.Errorf("%w: connecting requires the session ID", fault.Invalid)
	}
	if len(generation) > 0 && generation[0] < 1 {
		return nil, fmt.Errorf("%w: execution generation must be positive", fault.Invalid)
	}
	return c.connection(ctx, name, "/connect", id, generation, "")
}

// Environment opens the fixed unprivileged file/process adapter for this exact
// execution, separately from the persistent terminal program.
func (c *Client) Environment(ctx context.Context, name string, expected identity.Precondition, revision string) (Connection, error) {
	if expected.ID == "" || expected.Generation == nil || revision == "" {
		return nil, fmt.Errorf("%w: environment requires complete execution identity", fault.Invalid)
	}
	return c.connection(ctx, name, "/environment", expected.ID, []uint64{*expected.Generation}, revision)
}
func (c *Client) connection(ctx context.Context, name, suffix, id string, generation []uint64, revision string) (Connection, error) {
	ctx, cancel := context.WithCancel(ctx)
	in, input := io.Pipe()
	context.AfterFunc(ctx, func() { in.CloseWithError(ctx.Err()) })
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, base+sessionPath(name, suffix), in)
	if err != nil {
		cancel()
		in.Close()
		input.Close()
		return nil, err
	}
	req.Header.Set(SessionIDHeader, id)
	if len(generation) > 0 {
		req.Header.Set(SessionGenerationHeader, strconv.FormatUint(generation[0], 10))
	}
	if revision != "" {
		req.Header.Set(MachineRevisionHeader, revision)
	}
	req.Header.Set("Content-Type", "application/octet-stream")
	response, err := c.c.HTTP.Do(req)
	if err != nil {
		cancel()
		input.Close()
		return nil, err
	}
	if response.StatusCode != http.StatusOK {
		defer response.Body.Close()
		err := wire.ResponseError(response)
		cancel()
		input.Close()
		return nil, err
	}
	if (revision != "" && response.Header.Get(MachineRevisionHeader) != revision) || response.Header.Get(SessionIDHeader) != id || (len(generation) > 0 && response.Header.Get(SessionGenerationHeader) != strconv.FormatUint(generation[0], 10)) {
		response.Body.Close()
		cancel()
		input.Close()
		return nil, errors.New("the connection returned a different session identity")
	}
	return &clientConnection{input: input, response: response, cancel: cancel}, nil
}

type clientConnection struct {
	input    *io.PipeWriter
	response *http.Response
	cancel   context.CancelFunc
}

func (c *clientConnection) Read(p []byte) (int, error) {
	n, err := c.response.Body.Read(p)
	if errors.Is(err, io.EOF) && c.response.Trailer.Get(ConnectionErrorTrailer) != "" {
		err = errors.New("the program connection failed")
	}
	return n, err
}

func (c *clientConnection) Write(p []byte) (int, error) { return c.input.Write(p) }
func (c *clientConnection) CloseWrite() error           { return c.input.Close() }
func (c *clientConnection) Close() error {
	c.cancel()
	c.input.Close()
	return c.response.Body.Close()
}
