package api

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"

	"github.com/gshpychka/realm/packages/bay/internal/fault"
	"github.com/gshpychka/realm/packages/bay/internal/identity"
	"github.com/gshpychka/realm/packages/bay/internal/operations"
	"github.com/gshpychka/realm/packages/bay/internal/wire"
)

const ContentSHA256Header = "Bay-Content-SHA256"

// Operations owns isolated workspace transfer and detached commands. Every route remains on Bay's operator socket;
// none is exposed through the guest gateway.
type Operations interface {
	PutBlob(context.Context, string, identity.Precondition, string, io.Reader) (operations.Blob, error)
	Capture(context.Context, string, identity.Precondition, string, operations.Capture) (operations.Blob, error)
	ReadCapture(context.Context, string, identity.Precondition, string) (operations.Blob, io.ReadCloser, error)
	StartJob(context.Context, string, identity.Precondition, string, operations.Command) (operations.Job, error)
	Job(context.Context, string, identity.Precondition, string) (operations.Job, error)
}

func operationsHandler(mux *http.ServeMux, svc Service) {
	guard := func(w http.ResponseWriter, r *http.Request) (Operations, identity.Precondition, error) {
		id := r.Header.Values(SessionIDHeader)
		generation := r.Header.Values(SessionGenerationHeader)
		if len(id) != 1 || id[0] == "" || len(generation) != 1 {
			return nil, identity.Precondition{}, fmt.Errorf("%w: one session record ID and execution generation are required", fault.Invalid)
		}
		n, err := strconv.ParseUint(generation[0], 10, 64)
		if err != nil || n < 1 {
			return nil, identity.Precondition{}, fmt.Errorf("%w: invalid execution generation", fault.Invalid)
		}
		w.Header().Set("Cache-Control", "no-store")
		w.Header().Set(SessionIDHeader, id[0])
		w.Header().Set(SessionGenerationHeader, generation[0])
		return svc, identity.Precondition{ID: id[0], Generation: &n}, nil
	}
	mux.HandleFunc("PUT /v1/sessions/{name}/blobs/{digest}", func(w http.ResponseWriter, r *http.Request) {
		ops, expected, err := guard(w, r)
		if err != nil {
			wire.Fail(w, err)
			return
		}
		if r.ContentLength > operations.MaxBlobBytes {
			wire.Fail(w, fmt.Errorf("%w: blob exceeds its byte limit", fault.Invalid))
			return
		}
		r.Body = http.MaxBytesReader(w, r.Body, operations.MaxBlobBytes+1)
		blob, err := ops.PutBlob(r.Context(), r.PathValue("name"), expected, r.PathValue("digest"), r.Body)
		respond(w, blob, err)
	})
	mux.HandleFunc("POST /v1/sessions/{name}/captures/{capture}", func(w http.ResponseWriter, r *http.Request) {
		ops, expected, err := guard(w, r)
		if err != nil {
			wire.Fail(w, err)
			return
		}
		var request operations.Capture
		if err := wire.Read(r, &request); err != nil {
			wire.Fail(w, err)
			return
		}
		blob, err := ops.Capture(r.Context(), r.PathValue("name"), expected, r.PathValue("capture"), request)
		respond(w, blob, err)
	})
	mux.HandleFunc("GET /v1/sessions/{name}/captures/{capture}", func(w http.ResponseWriter, r *http.Request) {
		ops, expected, err := guard(w, r)
		if err != nil {
			wire.Fail(w, err)
			return
		}
		blob, reader, err := ops.ReadCapture(r.Context(), r.PathValue("name"), expected, r.PathValue("capture"))
		if err != nil {
			wire.Fail(w, err)
			return
		}
		defer reader.Close()
		w.Header().Set("Content-Type", "application/octet-stream")
		w.Header().Set("Content-Length", strconv.FormatInt(blob.Size, 10))
		w.Header().Set(ContentSHA256Header, blob.SHA256)
		w.WriteHeader(http.StatusOK)
		if n, err := io.Copy(w, reader); err != nil || n != blob.Size {
			panic(http.ErrAbortHandler)
		}
	})
	mux.HandleFunc("POST /v1/sessions/{name}/jobs/{job}", func(w http.ResponseWriter, r *http.Request) {
		ops, expected, err := guard(w, r)
		if err != nil {
			wire.Fail(w, err)
			return
		}
		var request operations.Command
		if err := wire.Read(r, &request); err != nil {
			wire.Fail(w, err)
			return
		}
		job, err := ops.StartJob(r.Context(), r.PathValue("name"), expected, r.PathValue("job"), request)
		respond(w, job, err)
	})
	mux.HandleFunc("GET /v1/sessions/{name}/jobs/{job}", func(w http.ResponseWriter, r *http.Request) {
		ops, expected, err := guard(w, r)
		if err != nil {
			wire.Fail(w, err)
			return
		}
		job, err := ops.Job(r.Context(), r.PathValue("name"), expected, r.PathValue("job"))
		respond(w, job, err)
	})
}

func (c *Client) operation(ctx context.Context, method, name, suffix string, expected identity.Precondition, body io.Reader, contentType string) (*http.Response, error) {
	if expected.ID == "" || expected.Generation == nil {
		return nil, fmt.Errorf("%w: record ID and generation are required", fault.Invalid)
	}
	req, err := http.NewRequestWithContext(ctx, method, base+sessionPath(name, suffix), body)
	if err != nil {
		return nil, err
	}
	req.Header.Set(SessionIDHeader, expected.ID)
	req.Header.Set(SessionGenerationHeader, strconv.FormatUint(*expected.Generation, 10))
	if contentType != "" {
		req.Header.Set("Content-Type", contentType)
	}
	resp, err := c.c.HTTP.Do(req)
	if err != nil {
		return nil, err
	}
	if resp.StatusCode < 200 || resp.StatusCode > 299 {
		defer resp.Body.Close()
		return nil, wire.ResponseError(resp)
	}
	if resp.Header.Get(SessionIDHeader) != expected.ID || resp.Header.Get(SessionGenerationHeader) != strconv.FormatUint(*expected.Generation, 10) {
		resp.Body.Close()
		return nil, fmt.Errorf("%w: operator operation returned another session execution", fault.Conflict)
	}
	return resp, nil
}

func (c *Client) PutBlob(ctx context.Context, name string, expected identity.Precondition, digest string, r io.Reader) (operations.Blob, error) {
	var blob operations.Blob
	resp, err := c.operation(ctx, http.MethodPut, name, "/blobs/"+url.PathEscape(digest), expected, r, "application/octet-stream")
	if err != nil {
		return blob, err
	}
	defer resp.Body.Close()
	err = json.NewDecoder(io.LimitReader(resp.Body, 1<<20)).Decode(&blob)
	return blob, err
}

func (c *Client) Capture(ctx context.Context, name string, expected identity.Precondition, id string, request operations.Capture) (operations.Blob, error) {
	var blob operations.Blob
	err := c.operationJSON(ctx, http.MethodPost, name, "/captures/"+url.PathEscape(id), expected, request, &blob)
	return blob, err
}

func (c *Client) ReadCapture(ctx context.Context, name string, expected identity.Precondition, id string) (operations.Blob, io.ReadCloser, error) {
	resp, err := c.operation(ctx, http.MethodGet, name, "/captures/"+url.PathEscape(id), expected, nil, "")
	if err != nil {
		return operations.Blob{}, nil, err
	}
	size, err := strconv.ParseInt(resp.Header.Get("Content-Length"), 10, 64)
	digest := resp.Header.Get(ContentSHA256Header)
	if err != nil || size < 0 || size > operations.MaxBlobBytes || !operations.ValidDigest(digest) {
		resp.Body.Close()
		return operations.Blob{}, nil, fmt.Errorf("invalid immutable capture response")
	}
	return operations.Blob{SHA256: digest, Size: size}, resp.Body, nil
}

func (c *Client) StartJob(ctx context.Context, name string, expected identity.Precondition, id string, request operations.Command) (operations.Job, error) {
	var job operations.Job
	err := c.operationJSON(ctx, http.MethodPost, name, "/jobs/"+url.PathEscape(id), expected, request, &job)
	return job, err
}

func (c *Client) Job(ctx context.Context, name string, expected identity.Precondition, id string) (operations.Job, error) {
	var job operations.Job
	err := c.operationJSON(ctx, http.MethodGet, name, "/jobs/"+url.PathEscape(id), expected, nil, &job)
	return job, err
}

func (c *Client) operationJSON(ctx context.Context, method, name, suffix string, expected identity.Precondition, input, result any) error {
	var body io.Reader
	if input != nil {
		data, err := json.Marshal(input)
		if err != nil {
			return err
		}
		body = bytes.NewReader(data)
	}
	resp, err := c.operation(ctx, method, name, suffix, expected, body, "application/json")
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	return json.NewDecoder(io.LimitReader(resp.Body, operations.MaxResponseBytes)).Decode(result)
}
