// Package environment is a disposable, unprivileged filesystem and shell connection.
// It owns open handles and command processes, never application state or a journal.
package environment

import (
	"bufio"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"syscall"

	"github.com/gshpychka/realm/packages/bay/internal/processes"
)

const maxFrame = 1 << 20
const maxChunk = 64 << 10
const maxHandles = 128

type request struct {
	Append     bool              `json:"append"`
	ID         uint64            `json:"id"`
	Op         string            `json:"op"`
	Path       string            `json:"path"`
	To         string            `json:"to"`
	Data       string            `json:"data"`
	Handle     uint64            `json:"handle"`
	Offset     int64             `json:"offset"`
	Length     int               `json:"length"`
	Recursive  bool              `json:"recursive"`
	Force      bool              `json:"force"`
	NoFollow   bool              `json:"noFollow"`
	Prefix     string            `json:"prefix"`
	Suffix     string            `json:"suffix"`
	Command    json.RawMessage   `json:"command"`
	Env        map[string]string `json:"env"`
	InheritEnv *bool             `json:"inheritEnv"`
	Timeout    int64             `json:"timeoutMs"`
	Spill      *spillOptions     `json:"spill"`
}
type spillOptions struct {
	AfterBytes int64 `json:"afterBytes"`
	AfterLines int64 `json:"afterLines"`
}
type failure struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}
type response struct {
	ID     uint64   `json:"id"`
	Value  any      `json:"value,omitempty"`
	Error  *failure `json:"error,omitempty"`
	Stream string   `json:"stream,omitempty"`
	Data   string   `json:"data,omitempty"`
}
type fileInfo struct {
	Name    string `json:"name"`
	Path    string `json:"path"`
	Kind    string `json:"kind"`
	Size    int64  `json:"size"`
	MtimeMs int64  `json:"mtimeMs"`
}
type handle struct {
	file      *os.File
	path      string
	directory bool
}
type connection struct {
	commandGroup func() (*os.File, func() error, error)
	credential   *syscall.Credential
	environment  []string
	writer       *json.Encoder
	output       sync.Mutex
	handles      map[uint64]handle
	nextHandle   uint64
	mu           sync.Mutex
	commands     map[uint64]context.CancelFunc
	closed       bool
	wg           sync.WaitGroup
}

// Operator keeps only process lifetime privileged. All filesystem requests pass
// to the fixed unprivileged file helper, and commands enter root-owned child
// cgroups before dropping to the same account. Commands cannot migrate out.
type Operator struct {
	FileInput   io.Reader
	FileOutput  io.Writer
	Credential  *syscall.Credential
	Environment []string
}

func (o Operator) Serve(input io.Reader, output io.Writer) error {
	if o.Credential == nil || o.Credential.Uid == 0 || o.FileInput == nil || o.FileOutput == nil {
		return fmt.Errorf("environment operator requires an unprivileged file helper and command account")
	}
	return serveConnection(input, output, processes.NewGroup, &o, false)
}

// ServeFiles owns only unprivileged file handles. Exec and cancel are never
// accepted on this private child pipe.
func ServeFiles(input io.Reader, output io.Writer) error {
	return serveConnection(input, output, nil, nil, true)
}

func serve(input io.Reader, output io.Writer, group func() (*os.File, func() error, error)) error {
	return serveConnection(input, output, group, nil, false)
}
func serveConnection(input io.Reader, output io.Writer, group func() (*os.File, func() error, error), operator *Operator, filesOnly bool) error {
	c := &connection{commandGroup: group, writer: json.NewEncoder(output), handles: map[uint64]handle{}, commands: map[uint64]context.CancelFunc{}}
	var fileInput *bufio.Scanner
	var fileOutput *json.Encoder
	if operator != nil {
		c.credential, c.environment = operator.Credential, operator.Environment
		fileInput = bufio.NewScanner(operator.FileInput)
		fileInput.Buffer(make([]byte, 4096), maxFrame)
		fileOutput = json.NewEncoder(operator.FileOutput)
	}
	defer c.close()
	scanner := bufio.NewScanner(input)
	scanner.Buffer(make([]byte, 4096), maxFrame)
	for scanner.Scan() {
		var r request
		decoder := json.NewDecoder(strings.NewReader(scanner.Text()))
		decoder.DisallowUnknownFields()
		if err := decoder.Decode(&r); err != nil || r.ID == 0 {
			return fmt.Errorf("invalid environment request")
		}
		if err := decoder.Decode(new(any)); !errors.Is(err, io.EOF) {
			return fmt.Errorf("environment request must contain one JSON object")
		}
		if r.Op == "exec" {
			if filesOnly {
				return fmt.Errorf("file helper cannot execute commands")
			}
			c.start(r)
			continue
		}
		if r.Op == "cancel" {
			if filesOnly {
				return fmt.Errorf("file helper cannot control commands")
			}
			c.mu.Lock()
			cancel := c.commands[r.Handle]
			c.mu.Unlock()
			if cancel != nil {
				cancel()
			}
			continue
		}
		if fileOutput != nil {
			if err := fileOutput.Encode(r); err != nil {
				return err
			}
			if !fileInput.Scan() {
				return fmt.Errorf("unprivileged file helper disconnected: %v", fileInput.Err())
			}
			var reply response
			if err := json.Unmarshal(fileInput.Bytes(), &reply); err != nil || reply.ID != r.ID || reply.Stream != "" {
				return fmt.Errorf("invalid unprivileged file helper response")
			}
			if err := c.send(reply); err != nil {
				return err
			}
			continue
		}
		value, err := c.file(r)
		if err := c.send(response{ID: r.ID, Value: value, Error: classify(err)}); err != nil {
			return err
		}
	}
	return scanner.Err()
}
func (c *connection) send(r response) error {
	c.output.Lock()
	defer c.output.Unlock()
	return c.writer.Encode(r)
}
func classify(err error) *failure {
	if err == nil {
		return nil
	}
	code := "unknown"
	switch {
	case errors.Is(err, fs.ErrNotExist):
		code = "not_found"
	case errors.Is(err, fs.ErrPermission):
		code = "permission_denied"
	case errors.Is(err, syscall.ENOTDIR):
		code = "not_directory"
	case errors.Is(err, syscall.EISDIR):
		code = "is_directory"
	case errors.Is(err, fs.ErrInvalid), errors.Is(err, syscall.ELOOP):
		code = "invalid"
	}
	return &failure{Code: code, Message: err.Error()}
}
func info(path string, st fs.FileInfo) (fileInfo, error) {
	kind := "file"
	switch {
	case st.Mode()&fs.ModeSymlink != 0:
		kind = "symlink"
	case st.IsDir():
		kind = "directory"
	case !st.Mode().IsRegular():
		return fileInfo{}, fs.ErrInvalid
	}
	return fileInfo{Name: filepath.Base(path), Path: path, Kind: kind, Size: st.Size(), MtimeMs: st.ModTime().UnixMilli()}, nil
}
func (c *connection) open(path string, directory, noFollow bool) (uint64, error) {
	if len(c.handles) >= maxHandles {
		return 0, fmt.Errorf("too many open environment handles")
	}
	flags := os.O_RDONLY | syscall.O_NONBLOCK
	if noFollow {
		flags |= syscall.O_NOFOLLOW
	}
	var f *os.File
	var err error
	if directory {
		// Files opened through Root keep ReadDir metadata relative to this
		// descriptor, even when the directory is renamed or its name reused.
		root, openErr := os.OpenRoot(path)
		if openErr != nil {
			return 0, openErr
		}
		f, err = root.Open(".")
		root.Close()
	} else {
		f, err = os.OpenFile(path, flags, 0)
	}
	if err != nil {
		return 0, err
	}
	st, err := f.Stat()
	if err == nil {
		if directory && !st.IsDir() {
			err = syscall.ENOTDIR
		}
		if !directory && st.IsDir() {
			err = syscall.EISDIR
		} else if !directory && !st.Mode().IsRegular() {
			err = fs.ErrInvalid
		}
	}
	if err != nil {
		f.Close()
		return 0, err
	}
	c.nextHandle++
	c.handles[c.nextHandle] = handle{f, path, directory}
	return c.nextHandle, nil
}
func (c *connection) file(r request) (any, error) {
	if strings.ContainsRune(r.Path, 0) || strings.ContainsRune(r.To, 0) {
		return nil, fs.ErrInvalid
	}
	switch r.Op {
	case "open":
		return c.open(r.Path, false, r.NoFollow)
	case "openDir":
		return c.open(r.Path, true, false)
	case "close":
		h, ok := c.handles[r.Handle]
		if !ok {
			return nil, nil
		}
		delete(c.handles, r.Handle)
		return nil, h.file.Close()
	case "info":
		st, err := os.Lstat(r.Path)
		if err != nil {
			return nil, err
		}
		return info(r.Path, st)
	case "handleInfo":
		h, ok := c.handles[r.Handle]
		if !ok {
			return nil, fs.ErrInvalid
		}
		st, err := h.file.Stat()
		if err != nil {
			return nil, err
		}
		return info(h.path, st)
	case "read":
		h, ok := c.handles[r.Handle]
		if !ok || h.directory || r.Offset < 0 || r.Length < 0 || r.Length > maxChunk {
			return nil, fs.ErrInvalid
		}
		data := make([]byte, r.Length)
		n, err := h.file.ReadAt(data, r.Offset)
		if errors.Is(err, io.EOF) {
			err = nil
		}
		return base64.StdEncoding.EncodeToString(data[:n]), err
	case "next":
		h, ok := c.handles[r.Handle]
		if !ok || !h.directory || r.Length < 1 || r.Length > 64 {
			return nil, fs.ErrInvalid
		}
		entries, err := h.file.ReadDir(r.Length)
		done := errors.Is(err, io.EOF)
		if err != nil && !done {
			return nil, err
		}
		items := make([]fileInfo, 0, len(entries))
		for _, entry := range entries {
			st, err := entry.Info()
			if errors.Is(err, fs.ErrNotExist) {
				continue
			}
			if err != nil {
				return nil, err
			}
			v, err := info(filepath.Join(h.path, entry.Name()), st)
			if errors.Is(err, fs.ErrInvalid) {
				continue
			}
			if err != nil {
				return nil, err
			}
			items = append(items, v)
		}
		return map[string]any{"entries": items, "done": done}, nil
	case "openWrite":
		if len(c.handles) >= maxHandles {
			return nil, fmt.Errorf("too many open environment handles")
		}
		flags := os.O_CREATE | os.O_WRONLY | syscall.O_NONBLOCK
		if r.Append {
			flags |= os.O_APPEND
		} else {
			flags |= os.O_TRUNC
		}
		f, err := os.OpenFile(r.Path, flags, 0666)
		if err != nil {
			return nil, err
		}
		st, err := f.Stat()
		if err == nil && !st.Mode().IsRegular() {
			err = fs.ErrInvalid
		}
		if err != nil {
			f.Close()
			return nil, err
		}
		c.nextHandle++
		c.handles[c.nextHandle] = handle{file: f, path: r.Path}
		return c.nextHandle, nil
	case "writeChunk":
		h, ok := c.handles[r.Handle]
		if !ok || h.directory {
			return nil, fs.ErrInvalid
		}
		data, err := base64.StdEncoding.DecodeString(r.Data)
		if err != nil || len(data) > maxChunk {
			return nil, fs.ErrInvalid
		}
		_, err = h.file.Write(data)
		return nil, err
	case "truncate":
		if r.Offset < 0 {
			return nil, fs.ErrInvalid
		}
		return nil, os.Truncate(r.Path, r.Offset)
	case "flush":
		f, err := os.OpenFile(r.Path, os.O_WRONLY|syscall.O_NONBLOCK, 0)
		if err != nil {
			return nil, err
		}
		defer f.Close()
		return nil, f.Sync()
	case "rename":
		return nil, os.Rename(r.Path, r.To)
	case "canonical":
		return filepath.EvalSymlinks(r.Path)
	case "exists":
		_, err := os.Stat(r.Path)
		if errors.Is(err, fs.ErrNotExist) {
			return false, nil
		}
		return err == nil, err
	case "mkdir":
		if r.Recursive {
			return nil, os.MkdirAll(r.Path, 0777)
		}
		return nil, os.Mkdir(r.Path, 0777)
	case "remove":
		if r.Recursive {
			if !r.Force {
				if _, err := os.Lstat(r.Path); err != nil {
					return nil, err
				}
			}
			return nil, os.RemoveAll(r.Path)
		}
		err := os.Remove(r.Path)
		if r.Force && errors.Is(err, fs.ErrNotExist) {
			err = nil
		}
		return nil, err
	case "tempDir":
		if strings.ContainsAny(r.Prefix, "/\\") {
			return nil, fs.ErrInvalid
		}
		return os.MkdirTemp("", r.Prefix+"*")
	case "tempFile":
		if strings.ContainsAny(r.Prefix+r.Suffix, "/\\") {
			return nil, fs.ErrInvalid
		}
		f, err := os.CreateTemp("", r.Prefix+"*"+r.Suffix)
		if err != nil {
			return nil, err
		}
		path := f.Name()
		return path, f.Close()
	default:
		return nil, fs.ErrInvalid
	}
}
func (c *connection) close() {
	c.mu.Lock()
	c.closed = true
	for _, cancel := range c.commands {
		cancel()
	}
	c.mu.Unlock()
	c.wg.Wait()
	for _, h := range c.handles {
		h.file.Close()
	}
}
