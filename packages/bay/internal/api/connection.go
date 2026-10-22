package api

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"time"

	"github.com/gshpychka/realm/packages/bay/internal/fault"
	"github.com/gshpychka/realm/packages/bay/internal/wire"
)

// SessionIDHeader binds a connection to a record, rather than a reusable name.
const SessionIDHeader = "Bay-Session-ID"

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
		control := http.NewResponseController(w)
		if err := control.EnableFullDuplex(); err != nil {
			wire.Fail(w, fmt.Errorf("duplex connections are unavailable: %w", err))
			return
		}
		w.Header().Set("Connection", "close")
		id := r.Header.Get(SessionIDHeader)
		if id == "" {
			wire.Fail(w, fmt.Errorf("%w: %s is required", fault.Invalid, SessionIDHeader))
			return
		}
		connection, err := svc.Connect(r.Context(), r.PathValue("name"), id)
		if err != nil {
			wire.Fail(w, err)
			return
		}
		defer connection.Close()
		w.Header().Set("Content-Type", "application/octet-stream")
		w.Header().Set("Cache-Control", "no-store")
		w.Header().Set("Connection", "close")
		w.Header().Set(SessionIDHeader, id)
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
		_, err = io.Copy(flushedWriter{w, control}, connection)
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
func (c *Client) Connect(ctx context.Context, name, id string) (Connection, error) {
	if id == "" {
		return nil, fmt.Errorf("%w: connecting requires the session ID", fault.Invalid)
	}
	ctx, cancel := context.WithCancel(ctx)
	in, input := io.Pipe()
	context.AfterFunc(ctx, func() { in.CloseWithError(ctx.Err()) })
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, base+sessionPath(name, "/connect"), in)
	if err != nil {
		cancel()
		in.Close()
		input.Close()
		return nil, err
	}
	req.Header.Set(SessionIDHeader, id)
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
	if response.Header.Get(SessionIDHeader) != id {
		response.Body.Close()
		cancel()
		input.Close()
		return nil, errors.New("the connection returned a different session ID")
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
