package repos

import (
	"archive/tar"
	"bytes"
	"context"
	"errors"
	"io"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
)

// entry is one file of a directory tree: a trailing slash in name marks a directory, and link a symlink.
type entry struct {
	name    string
	mode    fs.FileMode
	content string
	link    string
}

// tree is the shape of a bare repository, listed in the order writeTar visits it.
var tree = []entry{
	{name: "HEAD", mode: 0o644, content: "ref: refs/heads/main\n"},
	{name: "alias", mode: 0o777, link: "HEAD"},
	{name: "config", mode: 0o600, content: "[core]\n\tbare = true\n"},
	{name: "objects/", mode: 0o755},
	{name: "objects/ab/", mode: 0o755},
	{name: "objects/ab/cdef", mode: 0o444, content: "object"},
	{name: "refs/", mode: 0o755},
	{name: "refs/heads/", mode: 0o755},
	{name: "refs/heads/main", mode: 0o644, content: "0123456789012345678901234567890123456789\n"},
	{name: "refs/heads/" + strings.Repeat("é", 60), mode: 0o644, content: "a name past the tar header's 100 bytes"},
	{name: "refs/tags/", mode: 0o755},
}

func (e entry) isDir() bool { return strings.HasSuffix(e.name, "/") }

func writeTree(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	for _, e := range tree {
		path := filepath.Join(dir, e.name)
		var err error
		switch {
		case e.link != "":
			err = os.Symlink(e.link, path)
		case e.isDir():
			if err = os.MkdirAll(path, 0o755); err == nil {
				err = os.Chmod(path, e.mode)
			}
		default:
			if err = os.WriteFile(path, []byte(e.content), 0o600); err == nil {
				err = os.Chmod(path, e.mode)
			}
		}
		if err != nil {
			t.Fatal(err)
		}
	}
	return dir
}

func TestWriteTar(t *testing.T) {
	var buf bytes.Buffer
	if err := writeTar(context.Background(), &buf, writeTree(t)); err != nil {
		t.Fatal(err)
	}
	if !bytes.HasSuffix(buf.Bytes(), make([]byte, 1024)) {
		t.Error("the archive does not end with the tar end-of-archive marker")
	}
	tr := tar.NewReader(&buf)
	for _, e := range tree {
		hdr, err := tr.Next()
		if err != nil {
			t.Fatalf("the archive ends before %s: %v", e.name, err)
		}
		if hdr.Name != e.name {
			t.Fatalf("entry %q, want %q", hdr.Name, e.name)
		}
		wantType := byte(tar.TypeReg)
		switch {
		case e.link != "":
			wantType = tar.TypeSymlink
		case e.isDir():
			wantType = tar.TypeDir
		}
		if hdr.Typeflag != wantType || hdr.Linkname != e.link || hdr.Mode != int64(e.mode) {
			t.Errorf("%s is type %q, mode %o, link %q; want type %q, mode %o, link %q",
				e.name, hdr.Typeflag, hdr.Mode, hdr.Linkname, wantType, e.mode, e.link)
		}
		if hdr.Uid != 0 || hdr.Gid != 0 || hdr.Uname != "" || hdr.Gname != "" {
			t.Errorf("%s is owned by %d:%d (%q:%q), want root", e.name, hdr.Uid, hdr.Gid, hdr.Uname, hdr.Gname)
		}
		if wantType == tar.TypeReg {
			if data, _ := io.ReadAll(tr); string(data) != e.content {
				t.Errorf("%s holds %q, want %q", e.name, data, e.content)
			}
		}
	}
	if hdr, err := tr.Next(); err != io.EOF {
		t.Errorf("the archive holds more than the tree: %v, %v", hdr, err)
	}
}

func TestWriteTarExtractsWithTar(t *testing.T) {
	if _, err := exec.LookPath("tar"); err != nil {
		t.Skip("tar is not on PATH")
	}
	var buf bytes.Buffer
	if err := writeTar(context.Background(), &buf, writeTree(t)); err != nil {
		t.Fatal(err)
	}
	out := t.TempDir()
	untar := exec.Command("tar", "-C", out, "-xf", "-")
	untar.Stdin = &buf
	if msg, err := untar.CombinedOutput(); err != nil {
		t.Fatalf("tar: %v\n%s", err, msg)
	}
	for _, e := range tree {
		path := filepath.Join(out, e.name)
		switch {
		case e.link != "":
			if got, err := os.Readlink(path); err != nil || got != e.link {
				t.Errorf("%s links to %q, %v; want %q", e.name, got, err, e.link)
			}
		case e.isDir():
			if info, err := os.Stat(path); err != nil || !info.IsDir() {
				t.Errorf("%s is not a directory: %v", e.name, err)
			}
		default:
			if got, err := os.ReadFile(path); err != nil || string(got) != e.content {
				t.Errorf("%s holds %q, %v; want %q", e.name, got, err, e.content)
			}
		}
	}
}

func TestWriteTarRejectsUnsupportedFiles(t *testing.T) {
	dir := writeTree(t)
	if err := syscall.Mkfifo(filepath.Join(dir, "pipe"), 0o600); err != nil {
		t.Fatal(err)
	}
	err := writeTar(context.Background(), io.Discard, dir)
	if err == nil || !strings.Contains(err.Error(), "pipe") {
		t.Fatalf("writeTar of a tree holding a fifo returned %v, want an error naming it", err)
	}
}

func TestWriteTarStopsWhenCancelled(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	var buf bytes.Buffer
	if err := writeTar(ctx, &buf, writeTree(t)); !errors.Is(err, context.Canceled) {
		t.Fatalf("writeTar returned %v, want context.Canceled", err)
	}
}
