// Package operations defines bounded operator transfers and detached commands inside a session.
package operations

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io/fs"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/gshpychka/realm/packages/bay/internal/fault"
)

const (
	MaxBlobBytes   int64 = 128 << 20
	MaxOutputBytes int64 = 8 << 20
	MaxJobTimeout        = 30 * time.Minute
	// JSON can expand each output byte into a six-byte escape.
	MaxResponseBytes int64 = 6*MaxOutputBytes + 1<<20
)

type Blob struct {
	SHA256 string `json:"sha256"`
	Size   int64  `json:"size"`
	Path   string `json:"path"`
}

type Capture struct {
	Path     string `json:"path"`
	MaxBytes int64  `json:"maxBytes"`
}

type Command struct {
	Argv []string `json:"argv"`
	// Cwd is relative to /work. An empty value means /work itself.
	Cwd             string `json:"cwd"`
	TimeoutMS       int64  `json:"timeoutMs"`
	MaxOutputBytes  int64  `json:"maxOutputBytes"`
	InputDigest     string `json:"inputDigest,omitempty"`
	MachineRevision string `json:"machineRevision"`
}

type Status string

const (
	Running   Status = "running"
	Succeeded Status = "succeeded"
	Failed    Status = "failed"
	TimedOut  Status = "timed_out"
)

type Job struct {
	ID         string `json:"id"`
	RecordID   string `json:"recordId"`
	Generation uint64 `json:"generation"`
	Command
	Status   Status     `json:"status"`
	ExitCode *int       `json:"exitCode"`
	Stdout   string     `json:"stdout"`
	Stderr   string     `json:"stderr"`
	Error    string     `json:"error,omitempty"`
	Created  time.Time  `json:"created"`
	Started  *time.Time `json:"started,omitempty"`
	Finished *time.Time `json:"finished,omitempty"`
}

func ValidID(id string) bool {
	if len(id) < 1 || len(id) > 96 {
		return false
	}
	for _, r := range id {
		if !(r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' || r >= '0' && r <= '9' || r == '-' || r == '_') {
			return false
		}
	}
	return true
}

func ValidDigest(digest string) bool {
	if len(digest) != 64 {
		return false
	}
	for _, r := range digest {
		if !(r >= 'a' && r <= 'f' || r >= '0' && r <= '9') {
			return false
		}
	}
	return true
}

func ValidPath(path string) bool {
	return path != "" && len(path) <= 1024 && utf8.ValidString(path) && fs.ValidPath(path) && !strings.ContainsRune(path, '\x00')
}

func (c Capture) Validate() error {
	if !ValidPath(c.Path) || c.Path == "." {
		return fmt.Errorf("%w: capture path must name a file below /work", fault.Invalid)
	}
	if c.MaxBytes < 1 || c.MaxBytes > MaxBlobBytes {
		return fmt.Errorf("%w: capture limit must be between 1 and %d bytes", fault.Invalid, MaxBlobBytes)
	}
	return nil
}

func (c Command) Validate() error {
	if len(c.Argv) < 1 || len(c.Argv) > 128 || c.Argv[0] == "" {
		return fmt.Errorf("%w: command must name an executable and have at most 128 arguments", fault.Invalid)
	}
	n := 0
	for _, arg := range c.Argv {
		n += len(arg)
		if !utf8.ValidString(arg) || strings.ContainsRune(arg, '\x00') {
			return fmt.Errorf("%w: command contains invalid text", fault.Invalid)
		}
	}
	if n > 64<<10 {
		return fmt.Errorf("%w: command arguments exceed 64 KiB", fault.Invalid)
	}
	if c.Cwd != "" && !ValidPath(c.Cwd) {
		return fmt.Errorf("%w: command cwd must be below /work", fault.Invalid)
	}
	if c.TimeoutMS < 1 || c.TimeoutMS > MaxJobTimeout.Milliseconds() {
		return fmt.Errorf("%w: command timeout must be between 1 and %d ms", fault.Invalid, MaxJobTimeout.Milliseconds())
	}
	if c.MaxOutputBytes < 1 || c.MaxOutputBytes > MaxOutputBytes {
		return fmt.Errorf("%w: command output limit must be between 1 and %d bytes", fault.Invalid, MaxOutputBytes)
	}
	if c.InputDigest != "" && !ValidDigest(c.InputDigest) {
		return fmt.Errorf("%w: invalid command input digest", fault.Invalid)
	}
	if c.MachineRevision == "" || len(c.MachineRevision) > 128 || strings.ContainsRune(c.MachineRevision, '\x00') {
		return fmt.Errorf("%w: command requires its pinned machine revision", fault.Invalid)
	}
	return nil
}

// Digest binds stable operation IDs to their exact normalized request.
func Digest(value any) string {
	data, err := json.Marshal(value)
	if err != nil {
		panic(err)
	}
	digest := sha256.Sum256(data)
	return hex.EncodeToString(digest[:])
}
