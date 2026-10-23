package sessions

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"

	"github.com/gshpychka/realm/packages/bay/internal/fault"
	"github.com/gshpychka/realm/packages/bay/internal/guest"
	"github.com/gshpychka/realm/packages/bay/internal/identity"
	"github.com/gshpychka/realm/packages/bay/internal/operations"
	"github.com/gshpychka/realm/packages/bay/internal/records"
)

func (s *Service) operatorSession(ctx context.Context, name string, expected identity.Precondition) (records.Record, guest.Guest, func(), error) {
	if expected.ID == "" || expected.Generation == nil {
		return records.Record{}, guest.Guest{}, nil, fmt.Errorf("%w: operator transfers require record ID and execution generation", fault.Invalid)
	}
	release, err := s.claimSession(name, false)
	if err != nil {
		return records.Record{}, guest.Guest{}, nil, err
	}
	rec, err := s.record(name)
	if err == nil {
		err = checkExpected(rec, []identity.Precondition{expected})
	}
	if err == nil {
		err = s.require(ctx, name, InstanceRunning)
	}
	if err != nil {
		release()
		return records.Record{}, guest.Guest{}, nil, err
	}
	g := guest.New(func(ctx context.Context, argv []string, stdin io.Reader, stdout io.Writer) error {
		return s.instances.Connect(ctx, name, rec.ID, argv, stdin, stdout)
	})
	return rec, g, release, nil
}

func (s *Service) PutBlob(ctx context.Context, name string, expected identity.Precondition, digest string, r io.Reader) (operations.Blob, error) {
	if !operations.ValidDigest(digest) {
		return operations.Blob{}, fmt.Errorf("%w: invalid blob digest", fault.Invalid)
	}
	ctx, cancel := context.WithTimeout(ctx, operationTimeout)
	defer cancel()
	rec, g, release, err := s.operatorSession(ctx, name, expected)
	if err != nil {
		return operations.Blob{}, err
	}
	defer release()
	var result operations.Blob
	err = operatorJSON(ctx, g, rec, "put-blob", digest, io.LimitReader(r, operations.MaxBlobBytes+1), &result)
	return result, err
}

func (s *Service) Capture(ctx context.Context, name string, expected identity.Precondition, id string, request operations.Capture) (operations.Blob, error) {
	if !operations.ValidID(id) {
		return operations.Blob{}, fmt.Errorf("%w: invalid capture ID", fault.Invalid)
	}
	if err := request.Validate(); err != nil {
		return operations.Blob{}, err
	}
	ctx, cancel := context.WithTimeout(ctx, operationTimeout)
	defer cancel()
	rec, g, release, err := s.operatorSession(ctx, name, expected)
	if err != nil {
		return operations.Blob{}, err
	}
	defer release()
	data, _ := json.Marshal(request)
	var result operations.Blob
	err = operatorJSON(ctx, g, rec, "capture", id, bytes.NewReader(data), &result)
	return result, err
}

func (s *Service) ReadCapture(ctx context.Context, name string, expected identity.Precondition, id string) (operations.Blob, io.ReadCloser, error) {
	if !operations.ValidID(id) {
		return operations.Blob{}, nil, fmt.Errorf("%w: invalid capture ID", fault.Invalid)
	}
	ctx, cancel := context.WithTimeout(ctx, operationTimeout)
	rec, g, release, err := s.operatorSession(ctx, name, expected)
	if err != nil {
		cancel()
		return operations.Blob{}, nil, err
	}
	var result operations.Blob
	if err := operatorJSON(ctx, g, rec, "capture-info", id, nil, &result); err != nil {
		release()
		cancel()
		return operations.Blob{}, nil, err
	}
	if result.Size < 0 || result.Size > operations.MaxBlobBytes || !operations.ValidDigest(result.SHA256) {
		release()
		cancel()
		return operations.Blob{}, nil, fmt.Errorf("invalid capture receipt")
	}
	r, w := io.Pipe()
	go func() {
		defer release()
		defer cancel()
		err := g.Operator(ctx, rec.ID, rec.Generation, "read-capture", id, nil, w)
		w.CloseWithError(err)
	}()
	return result, &captureReader{PipeReader: r, cancel: cancel}, nil
}

type captureReader struct {
	*io.PipeReader
	cancel context.CancelFunc
}

func (r *captureReader) Close() error { r.cancel(); return r.PipeReader.Close() }

func (s *Service) StartJob(ctx context.Context, name string, expected identity.Precondition, id string, request operations.Command) (operations.Job, error) {
	if !operations.ValidID(id) {
		return operations.Job{}, fmt.Errorf("%w: invalid job ID", fault.Invalid)
	}
	if err := request.Validate(); err != nil {
		return operations.Job{}, err
	}
	ctx, cancel := detach(ctx)
	defer cancel()
	rec, g, release, err := s.operatorSession(ctx, name, expected)
	if err != nil {
		return operations.Job{}, err
	}
	defer release()
	if rec.Machine == nil || request.MachineRevision != rec.Machine.Revision {
		return operations.Job{}, fmt.Errorf("%w: command machine revision changed", fault.Conflict)
	}
	data, _ := json.Marshal(request)
	var result operations.Job
	err = operatorJSON(ctx, g, rec, "start-job", id, bytes.NewReader(data), &result)
	if err == nil {
		err = checkJob(rec, id, result)
	}
	return result, err
}

func (s *Service) Job(ctx context.Context, name string, expected identity.Precondition, id string) (operations.Job, error) {
	if !operations.ValidID(id) {
		return operations.Job{}, fmt.Errorf("%w: invalid job ID", fault.Invalid)
	}
	ctx, cancel := context.WithTimeout(ctx, operationTimeout)
	defer cancel()
	rec, g, release, err := s.operatorSession(ctx, name, expected)
	if err != nil {
		return operations.Job{}, err
	}
	defer release()
	var result operations.Job
	err = operatorJSON(ctx, g, rec, "job", id, nil, &result)
	if err == nil {
		err = checkJob(rec, id, result)
	}
	return result, err
}

func checkJob(rec records.Record, id string, job operations.Job) error {
	if rec.Machine == nil || job.ID != id || job.RecordID != rec.ID || job.Generation != rec.Generation || job.MachineRevision != rec.Machine.Revision {
		return fmt.Errorf("%w: command receipt belongs to another execution or machine", fault.Conflict)
	}
	if err := job.Command.Validate(); err != nil {
		return fmt.Errorf("invalid command receipt: %w", err)
	}
	// JSON replaces an invalid UTF-8 source byte with a three-byte replacement rune. The guest bounds raw bytes.
	if int64(len(job.Stdout)+len(job.Stderr)) > 3*job.MaxOutputBytes {
		return fmt.Errorf("command logs exceeded their byte limit")
	}
	return nil
}

func operatorJSON(ctx context.Context, g guest.Guest, rec records.Record, operation, key string, input io.Reader, result any) error {
	var out bytes.Buffer
	w := &operatorResponse{w: &out, remaining: operations.MaxResponseBytes}
	if err := g.Operator(ctx, rec.ID, rec.Generation, operation, key, input, w); err != nil {
		return err
	}
	var failure struct {
		Error string  `json:"error"`
		Kind  *string `json:"kind"`
	}
	if err := json.Unmarshal(out.Bytes(), &failure); err != nil {
		return fmt.Errorf("decode operator helper: %w", err)
	}
	// A completed job can carry its own error while remaining a successful transport response.
	if failure.Error != "" && failure.Kind != nil {
		var kind error
		switch *failure.Kind {
		case fault.Invalid.Error():
			kind = fault.Invalid
		case fault.Conflict.Error():
			kind = fault.Conflict
		case fault.NotFound.Error():
			kind = fault.NotFound
		case fault.Forbidden.Error():
			kind = fault.Forbidden
		}
		if kind != nil {
			return &helperFailure{kind: kind, message: failure.Error}
		}
		return fmt.Errorf("operator helper: %s", failure.Error)
	}
	return json.Unmarshal(out.Bytes(), result)
}

type helperFailure struct {
	kind    error
	message string
}

func (e *helperFailure) Error() string { return e.message }
func (e *helperFailure) Unwrap() error { return e.kind }

type operatorResponse struct {
	w         io.Writer
	remaining int64
}

func (w *operatorResponse) Write(p []byte) (int, error) {
	if int64(len(p)) > w.remaining {
		return 0, fmt.Errorf("operator helper response exceeded its byte limit")
	}
	w.remaining -= int64(len(p))
	return w.w.Write(p)
}
