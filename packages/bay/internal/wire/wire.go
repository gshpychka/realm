// Package wire carries JSON requests, responses and failures over HTTP between Bay's components.
package wire

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"

	"github.com/gshpychka/realm/packages/bay/internal/fault"
)

var statuses = map[error]int{
	fault.NotFound:  http.StatusNotFound,
	fault.Conflict:  http.StatusConflict,
	fault.Invalid:   http.StatusBadRequest,
	fault.Forbidden: http.StatusForbidden,
}

type failure struct {
	Error string `json:"error"`
	Code  string `json:"code,omitempty"`
}

// Write responds with status and v encoded as JSON.
func Write(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(v)
}

// Fail responds with err's text and the status matching its fault kind, or 500 when err has none.
func Fail(w http.ResponseWriter, err error) {
	status, ok := statuses[fault.Kind(err)]
	if !ok {
		status = http.StatusInternalServerError
	}
	Write(w, status, failure{Error: err.Error(), Code: fault.Code(err)})
}

// Read decodes one JSON object into v, rejecting unknown fields, trailing values
// and requests larger than 1 MiB. Escaped message bodies fit within this limit.
func Read(r *http.Request, v any) error {
	return read(r, v, false)
}

// ReadOptional applies Read's validation when a body is present, accepting an empty body as no options.
func ReadOptional(r *http.Request, v any) error {
	return read(r, v, true)
}

func read(r *http.Request, v any, optional bool) error {
	const maxRequest = 1 << 20
	data, err := io.ReadAll(io.LimitReader(r.Body, maxRequest+1))
	if err != nil {
		return fmt.Errorf("%w: request body: %v", fault.Invalid, err)
	}
	if len(data) > maxRequest {
		return fmt.Errorf("%w: request body exceeds %d bytes", fault.Invalid, maxRequest)
	}
	trimmed := bytes.TrimSpace(data)
	if optional && len(trimmed) == 0 {
		return nil
	}
	if len(trimmed) == 0 || trimmed[0] != '{' {
		return fmt.Errorf("%w: request body must be a JSON object", fault.Invalid)
	}
	dec := json.NewDecoder(bytes.NewReader(data))
	dec.DisallowUnknownFields()
	if err := dec.Decode(v); err != nil {
		return fmt.Errorf("%w: request body: %v", fault.Invalid, err)
	}
	if err := dec.Decode(new(any)); !errors.Is(err, io.EOF) {
		return fmt.Errorf("%w: request body must contain one JSON object", fault.Invalid)
	}
	return nil
}

// statusError is a failure response; it matches the fault kind of its status.
type statusError struct {
	status  int
	message string
	code    string
}

func (e *statusError) Error() string     { return e.message }
func (e *statusError) FaultCode() string { return e.code }

func (e *statusError) Unwrap() error {
	if e.status == http.StatusConflict && e.code == fault.CapacityExhaustedCode {
		return fault.Capacity
	}
	for kind, status := range statuses {
		if status == e.status {
			return kind
		}
	}
	return nil
}

// Client sends JSON requests to one server.
type Client struct {
	HTTP *http.Client
	// Base is prefixed to every request path.
	Base string
}

// Unix returns an HTTP client whose every connection goes to the unix socket at path.
func Unix(path string) *http.Client {
	return &http.Client{Transport: UnixTransport(path)}
}

// UnixTransport returns an HTTP transport whose every connection goes to the unix socket at path.
func UnixTransport(path string) *http.Transport {
	return &http.Transport{
		DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
			var d net.Dialer
			return d.DialContext(ctx, "unix", path)
		},
	}
}

// Do sends in as JSON, or no body when in is nil, and decodes a success response into out unless out is nil.
func (c Client) Do(ctx context.Context, method, path string, in, out any) error {
	var body io.Reader
	if in != nil {
		data, err := json.Marshal(in)
		if err != nil {
			return err
		}
		body = bytes.NewReader(data)
	}
	req, err := http.NewRequestWithContext(ctx, method, c.Base+path, body)
	if err != nil {
		return err
	}
	if in != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	resp, err := c.HTTP.Do(req)
	if err != nil {
		var failed *url.Error
		if errors.As(err, &failed) {
			return failed.Err
		}
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode > 299 {
		return ResponseError(resp)
	}
	if out == nil {
		return nil
	}
	return json.NewDecoder(resp.Body).Decode(out)
}

// ResponseError decodes an unsuccessful response, retaining its fault kind.
func ResponseError(resp *http.Response) error {
	var f failure
	if err := json.NewDecoder(io.LimitReader(resp.Body, 1<<20)).Decode(&f); err != nil || f.Error == "" {
		f.Error = resp.Status
		f.Code = ""
	}
	return &statusError{status: resp.StatusCode, message: f.Error, code: f.Code}
}
