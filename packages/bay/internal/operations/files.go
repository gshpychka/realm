package operations

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"

	"github.com/gshpychka/realm/packages/bay/internal/fault"
)

// Guest owns immutable bytes and command receipts outside the writable workspace.
// Bay invokes it as root through Incus; commands themselves always run as the session user.
type Guest struct {
	Root       string
	Work       string
	User       string
	Home       string
	RecordID   string
	Generation uint64
	// Launch starts a detached runner. Production uses a transient systemd service.
	Launch func(jobID string) error
	// Source tests inject a process-group fallback without a systemd service.
	commandGroup func() (*os.File, func() error, error)
}

func (g Guest) namespace() string {
	return filepath.Join(g.Root, "operator", g.RecordID, strconv.FormatUint(g.Generation, 10))
}
func (g Guest) blobPath(digest string) string { return filepath.Join(g.Root, "blobs", digest) }
func (g Guest) jobPath(id string) string      { return filepath.Join(g.namespace(), "jobs", id) }

func (g Guest) prepare() error {
	if !ValidID(g.RecordID) {
		return fmt.Errorf("%w: invalid session record ID", fault.Invalid)
	}
	for _, dir := range []string{g.Root, filepath.Join(g.Root, "blobs")} {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			return err
		}
	}
	if err := os.MkdirAll(filepath.Join(g.Root, "operator"), 0o700); err != nil {
		return err
	}
	for _, dir := range []string{filepath.Join(g.namespace(), "jobs"), filepath.Join(g.namespace(), "captures")} {
		if err := os.MkdirAll(dir, 0o700); err != nil {
			return err
		}
	}
	for dir, prefix := range map[string]string{filepath.Join(g.Root, "blobs"): ".upload-", filepath.Join(g.namespace(), "captures"): ".capture-", filepath.Join(g.namespace(), "jobs"): ".job-"} {
		if err := cleanupStaging(dir, prefix); err != nil {
			return err
		}
	}
	return nil
}

func (g Guest) PutBlob(digest string, r io.Reader) (Blob, error) {
	if !ValidDigest(digest) {
		return Blob{}, fmt.Errorf("%w: invalid blob SHA-256", fault.Invalid)
	}
	if err := g.prepare(); err != nil {
		return Blob{}, err
	}
	tmp, err := os.CreateTemp(filepath.Join(g.Root, "blobs"), stagingPrefix(".upload-"))
	if err != nil {
		return Blob{}, err
	}
	defer os.Remove(tmp.Name())
	defer tmp.Close()
	hash := sha256.New()
	n, err := io.Copy(io.MultiWriter(tmp, hash), io.LimitReader(r, MaxBlobBytes+1))
	if err != nil {
		return Blob{}, err
	}
	if n > MaxBlobBytes {
		return Blob{}, fmt.Errorf("%w: blob exceeds %d bytes", fault.Invalid, MaxBlobBytes)
	}
	if hex.EncodeToString(hash.Sum(nil)) != digest {
		return Blob{}, fmt.Errorf("%w: blob bytes do not match SHA-256", fault.Invalid)
	}
	if err := tmp.Chmod(0o444); err != nil {
		return Blob{}, err
	}
	if err := tmp.Sync(); err != nil {
		return Blob{}, err
	}
	if err := tmp.Close(); err != nil {
		return Blob{}, err
	}
	dest := g.blobPath(digest)
	if err := os.Link(tmp.Name(), dest); err != nil && !errors.Is(err, fs.ErrExist) {
		return Blob{}, err
	}
	if err := syncDirectory(filepath.Dir(dest)); err != nil {
		return Blob{}, err
	}
	return g.Blob(digest)
}

func (g Guest) Blob(digest string) (Blob, error) {
	if !ValidDigest(digest) {
		return Blob{}, fmt.Errorf("%w: invalid blob SHA-256", fault.Invalid)
	}
	path := g.blobPath(digest)
	info, err := os.Lstat(path)
	if errors.Is(err, fs.ErrNotExist) {
		return Blob{}, fmt.Errorf("%w: no blob %s", fault.NotFound, digest)
	}
	if err != nil {
		return Blob{}, err
	}
	if !info.Mode().IsRegular() || info.Size() > MaxBlobBytes {
		return Blob{}, fmt.Errorf("%w: invalid immutable blob", fault.Conflict)
	}
	return Blob{SHA256: digest, Size: info.Size(), Path: path}, nil
}

type captureRecord struct {
	Request Capture `json:"request"`
	Blob    Blob    `json:"blob"`
}

func (g Guest) Capture(id string, request Capture) (Blob, error) {
	if !ValidID(id) {
		return Blob{}, fmt.Errorf("%w: invalid capture ID", fault.Invalid)
	}
	if err := request.Validate(); err != nil {
		return Blob{}, err
	}
	if err := g.prepare(); err != nil {
		return Blob{}, err
	}
	dest := filepath.Join(g.namespace(), "captures", id)
	if existing, err := readJSON[captureRecord](filepath.Join(dest, "receipt.json")); err == nil {
		if existing.Request != request {
			return Blob{}, fmt.Errorf("%w: capture ID has another request", fault.Conflict)
		}
		return existing.Blob, nil
	} else if !errors.Is(err, fs.ErrNotExist) {
		return Blob{}, err
	}
	root, err := os.OpenRoot(g.Work)
	if err != nil {
		return Blob{}, err
	}
	defer root.Close()
	// O_NONBLOCK lets us reject FIFOs/devices before an attacker can hold an operator transfer open in open(2).
	source, err := root.OpenFile(request.Path, os.O_RDONLY|syscall.O_NONBLOCK, 0)
	if err != nil {
		return Blob{}, fmt.Errorf("%w: capture source is unavailable: %v", fault.Invalid, err)
	}
	defer source.Close()
	info, err := source.Stat()
	if err != nil {
		return Blob{}, err
	}
	if !info.Mode().IsRegular() {
		return Blob{}, fmt.Errorf("%w: captures require a regular file", fault.Invalid)
	}
	if info.Size() > request.MaxBytes {
		return Blob{}, fmt.Errorf("%w: capture exceeds its byte limit", fault.Invalid)
	}
	staging, err := os.MkdirTemp(filepath.Dir(dest), stagingPrefix(".capture-"))
	if err != nil {
		return Blob{}, err
	}
	defer os.RemoveAll(staging)
	content, err := os.OpenFile(filepath.Join(staging, "content"), os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		return Blob{}, err
	}
	hash := sha256.New()
	n, copyErr := io.Copy(io.MultiWriter(content, hash), io.LimitReader(source, request.MaxBytes+1))
	if copyErr == nil {
		copyErr = content.Sync()
	}
	if closeErr := content.Close(); copyErr == nil {
		copyErr = closeErr
	}
	if copyErr != nil {
		return Blob{}, copyErr
	}
	if n > request.MaxBytes {
		return Blob{}, fmt.Errorf("%w: capture grew beyond its byte limit", fault.Invalid)
	}
	blob := Blob{SHA256: hex.EncodeToString(hash.Sum(nil)), Size: n, Path: filepath.Join(dest, "content")}
	if err := writeJSON(filepath.Join(staging, "receipt.json"), captureRecord{Request: request, Blob: blob}); err != nil {
		return Blob{}, err
	}
	if err := syncDirectory(staging); err != nil {
		return Blob{}, err
	}
	if err := os.Rename(staging, dest); err != nil {
		if errors.Is(err, fs.ErrExist) {
			return g.Capture(id, request)
		}
		return Blob{}, err
	}
	if err := syncDirectory(filepath.Dir(dest)); err != nil {
		return Blob{}, err
	}
	return blob, nil
}

func (g Guest) CaptureInfo(id string) (Blob, error) {
	if !ValidID(id) {
		return Blob{}, fmt.Errorf("%w: invalid capture ID", fault.Invalid)
	}
	record, err := readJSON[captureRecord](filepath.Join(g.namespace(), "captures", id, "receipt.json"))
	if errors.Is(err, fs.ErrNotExist) {
		return Blob{}, fmt.Errorf("%w: no capture %s", fault.NotFound, id)
	}
	return record.Blob, err
}

func (g Guest) ReadCapture(id string, w io.Writer) error {
	blob, err := g.CaptureInfo(id)
	if err != nil {
		return err
	}
	f, err := os.Open(blob.Path)
	if err != nil {
		return err
	}
	defer f.Close()
	hash := sha256.New()
	n, err := io.Copy(io.MultiWriter(w, hash), io.LimitReader(f, blob.Size+1))
	if err != nil {
		return err
	}
	if n != blob.Size || hex.EncodeToString(hash.Sum(nil)) != blob.SHA256 {
		return fmt.Errorf("immutable capture bytes changed")
	}
	return nil
}

func readJSON[T any](path string) (T, error) {
	var value T
	data, err := os.ReadFile(path)
	if err != nil {
		return value, err
	}
	err = json.Unmarshal(data, &value)
	return value, err
}

func writeJSON(path string, value any) error {
	data, err := json.Marshal(value)
	if err != nil {
		return err
	}
	tmp, err := os.CreateTemp(filepath.Dir(path), ".json-")
	if err != nil {
		return err
	}
	defer os.Remove(tmp.Name())
	if _, err = tmp.Write(data); err == nil {
		err = tmp.Sync()
	}
	if closeErr := tmp.Close(); err == nil {
		err = closeErr
	}
	if err != nil {
		return err
	}
	if err := os.Rename(tmp.Name(), path); err != nil {
		return err
	}
	return syncDirectory(filepath.Dir(path))
}

func syncDirectory(path string) error {
	dir, err := os.Open(path)
	if err != nil {
		return err
	}
	defer dir.Close()
	return dir.Sync()
}

func stagingPrefix(kind string) string {
	return kind + strconv.Itoa(os.Getpid()) + "-" + processIdentity(os.Getpid()) + "-"
}

// Interrupted uploads/captures can be killed before their defers run. Reclaim only a dead creator's staging bytes;
// the process start identity prevents PID reuse from making an unrelated live process protect abandoned storage.
func cleanupStaging(dir, prefix string) error {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return err
	}
	for _, entry := range entries {
		if !strings.HasPrefix(entry.Name(), prefix) {
			continue
		}
		pidText, tail, ok := strings.Cut(strings.TrimPrefix(entry.Name(), prefix), "-")
		if !ok {
			continue
		}
		process, _, ok := strings.Cut(tail, "-")
		if !ok {
			continue
		}
		pid, err := strconv.Atoi(pidText)
		if err != nil || pid < 1 {
			continue
		}
		if processIdentity(pid) == process && process != "" {
			continue
		}
		if err := os.RemoveAll(filepath.Join(dir, entry.Name())); err != nil {
			return err
		}
	}
	return nil
}
