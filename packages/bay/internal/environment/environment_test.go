package environment

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"io"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

type testConnection struct {
	net.Conn
	encoder *json.Encoder
	decoder *json.Decoder
	next    uint64
}

type failedOutput struct{ accepted int }

func (w *failedOutput) Write(p []byte) (int, error) {
	if w.accepted == 0 {
		return 0, io.ErrClosedPipe
	}
	w.accepted--
	return len(p), nil
}

func TestFailedOutputDeliveryRemovesTheSpool(t *testing.T) {
	shell, err := exec.LookPath("sh")
	if err != nil {
		t.Skip(err)
	}
	for name, accepted := range map[string]int{"stream": 0, "final response": 1} {
		t.Run(name, func(t *testing.T) {
			root := t.TempDir()
			t.Setenv("TMPDIR", root)
			c := &connection{writer: json.NewEncoder(&failedOutput{accepted}), commandGroup: func() (*os.File, func() error, error) { return nil, func() error { return nil }, nil }}
			argv, _ := json.Marshal([]string{shell, "-c", "printf captured"})
			c.run(context.Background(), request{ID: 1, Path: root, Command: argv, Spill: &spillOptions{AfterBytes: 1, AfterLines: 100}})
			entries, err := os.ReadDir(root)
			if err != nil || len(entries) != 0 {
				t.Fatalf("failed output delivery retained its spool: %v %v", entries, err)
			}
		})
	}
}

func openTest(t *testing.T) *testConnection {
	t.Helper()
	client, server := net.Pipe()
	done := make(chan error, 1)
	go func() {
		defer server.Close()
		done <- serve(server, server, func() (*os.File, func() error, error) { return nil, func() error { return nil }, nil })
	}()
	t.Cleanup(func() {
		client.Close()
		select {
		case <-done:
		case <-time.After(3 * time.Second):
			t.Error("environment failed to stop")
		}
	})
	return &testConnection{Conn: client, encoder: json.NewEncoder(client), decoder: json.NewDecoder(client)}
}
func (c *testConnection) call(t *testing.T, r request) response {
	t.Helper()
	c.next++
	r.ID = c.next
	if err := c.encoder.Encode(r); err != nil {
		t.Fatal(err)
	}
	var result response
	if err := c.decoder.Decode(&result); err != nil {
		t.Fatal(err)
	}
	if result.ID != r.ID {
		t.Fatalf("response %d for request %d", result.ID, r.ID)
	}
	return result
}
func number(t *testing.T, r response) uint64 {
	t.Helper()
	if r.Error != nil {
		t.Fatal(r.Error)
	}
	return uint64(r.Value.(float64))
}

func TestOpenedFileSurvivesRenameAndNoFollowRejectsLinks(t *testing.T) {
	c := openTest(t)
	root := t.TempDir()
	source, destination := filepath.Join(root, "source"), filepath.Join(root, "destination")
	os.WriteFile(source, []byte("first\nsecond"), 0600)
	handle := number(t, c.call(t, request{Op: "open", Path: source}))
	if r := c.call(t, request{Op: "rename", Path: source, To: destination}); r.Error != nil {
		t.Fatal(r.Error)
	}
	os.WriteFile(source, []byte("replacement"), 0600)
	r := c.call(t, request{Op: "read", Handle: handle, Offset: 6, Length: 6})
	if r.Error != nil {
		t.Fatal(r.Error)
	}
	data, err := base64.StdEncoding.DecodeString(r.Value.(string))
	if err != nil || string(data) != "second" {
		t.Fatalf("opened file changed: %s %v", data, err)
	}
	os.Symlink(destination, filepath.Join(root, "link"))
	if r := c.call(t, request{Op: "open", Path: filepath.Join(root, "link"), NoFollow: true}); r.Error == nil || r.Error.Code != "invalid" {
		t.Fatalf("followed symlink: %+v", r)
	}
	if r := c.call(t, request{Op: "open", Path: root}); r.Error == nil || r.Error.Code != "is_directory" {
		t.Fatalf("opened directory as regular file: %+v", r)
	}
	c.call(t, request{Op: "close", Handle: handle})
	if r := c.call(t, request{Op: "read", Handle: handle, Length: 1}); r.Error == nil {
		t.Fatal("closed handle remained usable")
	}
}
func TestDirectoryReaderPagesRealEntries(t *testing.T) {
	c := openTest(t)
	root := t.TempDir()
	for _, name := range []string{"a", "b", "c"} {
		os.WriteFile(filepath.Join(root, name), nil, 0600)
	}
	handle := number(t, c.call(t, request{Op: "openDir", Path: root}))
	count := 0
	for {
		r := c.call(t, request{Op: "next", Handle: handle, Length: 2})
		if r.Error != nil {
			t.Fatal(r.Error)
		}
		page := r.Value.(map[string]any)
		count += len(page["entries"].([]any))
		if page["done"].(bool) {
			break
		}
	}
	if count != 3 {
		t.Fatalf("directory returned %d entries", count)
	}
}

func TestDirectoryReaderKeepsMetadataBoundToTheOpenedDirectory(t *testing.T) {
	c := openTest(t)
	root := t.TempDir()
	path, moved := filepath.Join(root, "directory"), filepath.Join(root, "moved")
	if err := os.Mkdir(path, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(path, "entry"), []byte("original"), 0600); err != nil {
		t.Fatal(err)
	}
	handle := number(t, c.call(t, request{Op: "openDir", Path: path}))
	if err := os.Rename(path, moved); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(path, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(path, "entry"), []byte("replacement directory entry"), 0600); err != nil {
		t.Fatal(err)
	}
	r := c.call(t, request{Op: "next", Handle: handle, Length: 2})
	if r.Error != nil {
		t.Fatal(r.Error)
	}
	entries := r.Value.(map[string]any)["entries"].([]any)
	if len(entries) != 1 || entries[0].(map[string]any)["size"] != float64(len("original")) {
		t.Fatalf("opened directory resolved metadata through a reused path: %+v", entries)
	}
}

func TestShellStreamsBothOutputsAndSpillsCompleteBytes(t *testing.T) {
	shell, err := exec.LookPath("sh")
	if err != nil {
		t.Skip(err)
	}
	c := openTest(t)
	c.next++
	id := c.next
	command, _ := json.Marshal([]string{shell, "-c", "printf hello; printf world >&2; exit 7"})
	if err := c.encoder.Encode(request{ID: id, Op: "exec", Path: t.TempDir(), Command: command, Spill: &spillOptions{AfterBytes: 4, AfterLines: 100}}); err != nil {
		t.Fatal(err)
	}
	var out strings.Builder
	streams := map[string]bool{}
	for {
		var frame response
		if err := c.decoder.Decode(&frame); err != nil {
			t.Fatal(err)
		}
		if frame.Stream != "" {
			data, _ := base64.StdEncoding.DecodeString(frame.Data)
			out.Write(data)
			streams[frame.Stream] = true
			continue
		}
		if frame.Error != nil {
			t.Fatal(frame.Error)
		}
		value := frame.Value.(map[string]any)
		if value["exitCode"] != float64(7) {
			t.Fatal(value)
		}
		path := value["spillPath"].(string)
		defer os.Remove(path)
		data, err := os.ReadFile(path)
		if err != nil || string(data) != out.String() || len(data) != 10 || !streams["stdout"] || !streams["stderr"] {
			t.Fatalf("stream/spill mismatch: %q %q %v", out.String(), data, err)
		}
		break
	}
}
func TestCancellationStopsOnlyItsCommand(t *testing.T) {
	shell, err := exec.LookPath("sh")
	if err != nil {
		t.Skip(err)
	}
	c := openTest(t)
	command, _ := json.Marshal([]string{shell, "-c", "sleep 30"})
	if err := c.encoder.Encode(request{ID: 1, Op: "exec", Path: t.TempDir(), Command: command}); err != nil {
		t.Fatal(err)
	}
	if err := c.encoder.Encode(request{ID: 2, Op: "cancel", Handle: 1}); err != nil {
		t.Fatal(err)
	}
	c.SetReadDeadline(time.Now().Add(3 * time.Second))
	var frame response
	if err := c.decoder.Decode(&frame); err != nil {
		t.Fatal(err)
	}
	if frame.ID != 1 || frame.Error == nil || frame.Error.Code != "aborted" {
		t.Fatalf("cancelled command: %+v", frame)
	}
	c.SetReadDeadline(time.Time{})
	c.next = 2
	if r := c.call(t, request{Op: "exists", Path: t.TempDir()}); r.Error != nil || r.Value != true {
		t.Fatalf("cancel closed environment: %+v", r)
	}
}
func TestMalformedFrameClosesConnection(t *testing.T) {
	c := openTest(t)
	io.WriteString(c, "{invalid}\n")
	c.SetReadDeadline(time.Now().Add(time.Second))
	var b [1]byte
	if _, err := c.Read(b[:]); err == nil {
		t.Fatal("malformed frame accepted")
	}
}

func TestFileHelperNeverAcceptsProcessOperations(t *testing.T) {
	for _, op := range []string{"exec", "cancel"} {
		input := strings.NewReader(`{"id":1,"op":"` + op + `"}` + "\n")
		if err := ServeFiles(input, io.Discard); err == nil {
			t.Fatalf("unprivileged file helper accepted %s", op)
		}
	}
}

func TestShellTimeoutUsesMillisecondsOnTheHelperWire(t *testing.T) {
	shell, err := exec.LookPath("sh")
	if err != nil {
		t.Skip(err)
	}
	c := openTest(t)
	argv, _ := json.Marshal([]string{shell, "-c", "sleep 30"})
	if err := c.encoder.Encode(request{ID: 1, Op: "exec", Path: t.TempDir(), Command: argv, Timeout: 25}); err != nil {
		t.Fatal(err)
	}
	c.SetReadDeadline(time.Now().Add(3 * time.Second))
	var frame response
	if err := c.decoder.Decode(&frame); err != nil {
		t.Fatal(err)
	}
	if frame.ID != 1 || frame.Error == nil || frame.Error.Code != "timeout" {
		t.Fatalf("timeout outcome: %+v", frame)
	}
}
