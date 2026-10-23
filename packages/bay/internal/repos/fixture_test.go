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
	"slices"
	"strings"
	"testing"

	"github.com/gshpychka/realm/packages/bay/internal/records"
	"github.com/gshpychka/realm/packages/bay/internal/sessions"
)

func requireGit(t *testing.T) {
	t.Helper()
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git is not on PATH")
	}
}

// runGit runs git in dir (the current directory when empty) and returns its trimmed stdout.
func runGit(t *testing.T, dir string, args ...string) string {
	t.Helper()
	cmd := exec.Command("git", args...)
	cmd.Dir = dir
	cmd.Env = append(slices.DeleteFunc(os.Environ(), func(kv string) bool { return strings.HasPrefix(kv, "GIT_") }),
		"HOME="+t.TempDir(),
		"GIT_CONFIG_NOSYSTEM=1",
		"GIT_CONFIG_GLOBAL="+os.DevNull,
		"GIT_AUTHOR_NAME=bay", "GIT_AUTHOR_EMAIL=bay@example.com",
		"GIT_COMMITTER_NAME=bay", "GIT_COMMITTER_EMAIL=bay@example.com",
		"GIT_AUTHOR_DATE=2026-10-05T12:00:00Z", "GIT_COMMITTER_DATE=2026-10-05T12:00:00Z",
	)
	out, err := cmd.Output()
	if err != nil {
		var exit *exec.ExitError
		var stderr []byte
		if errors.As(err, &exit) {
			stderr = exit.Stderr
		}
		t.Fatalf("git %s: %v\n%s", strings.Join(args, " "), err, stderr)
	}
	return strings.TrimSpace(string(out))
}

// upstream is a repo the mirrors follow.
type upstream struct {
	t   *testing.T
	dir string
}

func newUpstream(t *testing.T, base, owner, name string) *upstream {
	t.Helper()
	u := &upstream{t: t, dir: filepath.Join(base, owner, name+".git")}
	if err := os.MkdirAll(u.dir, 0o755); err != nil {
		t.Fatal(err)
	}
	u.git("init", "--quiet", "--initial-branch=main")
	return u
}

func (u *upstream) git(args ...string) string {
	u.t.Helper()
	return runGit(u.t, u.dir, args...)
}

// commit adds a commit with the given content to the current branch and returns its ID.
func (u *upstream) commit(content string) string {
	u.t.Helper()
	if err := os.WriteFile(filepath.Join(u.dir, "file.txt"), []byte(content), 0o644); err != nil {
		u.t.Fatal(err)
	}
	u.git("add", "file.txt")
	u.git("commit", "--quiet", "-m", content)
	return u.git("rev-parse", "HEAD")
}

// history is the commits seed creates.
type history struct{ first, second, feature string }

// seed gives u two commits on main, the tags v1 (lightweight, on the first commit) and v2 (annotated, on the second),
// the branch feature/x one commit ahead of main, and a pull request ref.
func seed(u *upstream) history {
	u.t.Helper()
	var h history
	h.first = u.commit("one")
	u.git("tag", "v1")
	h.second = u.commit("two")
	u.git("tag", "--annotate", "--message", "second", "v2")
	u.git("checkout", "--quiet", "-b", "feature/x")
	h.feature = u.commit("three")
	u.git("checkout", "--quiet", "main")
	u.git("update-ref", "refs/pull/1/head", h.feature)
	return h
}

// fixture is Mirrors following repos served from a file:// base.
type fixture struct {
	t    *testing.T
	base string // upstream repos live at base/<owner>/<name>.git
	root string
	m    *Mirrors
}

func newFixture(t *testing.T) *fixture {
	t.Helper()
	requireGit(t)
	f := &fixture{t: t, base: t.TempDir(), root: t.TempDir()}
	f.m = f.mirrors()
	return f
}

func (f *fixture) mirrors() *Mirrors {
	f.t.Helper()
	m, err := New(f.root, "file://"+f.base+"/")
	if err != nil {
		f.t.Fatal(err)
	}
	return m
}

func (f *fixture) upstream(owner, name string) *upstream {
	return newUpstream(f.t, f.base, owner, name)
}

func (f *fixture) resolve(owner, name, ref string) (records.Repo, error) {
	return f.m.Resolve(context.Background(), sessions.RepoRef{Owner: owner, Name: name, Ref: ref})
}

func (f *fixture) mirrorDir(owner, name string) string {
	return filepath.Join(f.root, owner, name+".git")
}

// mirrorGit runs git against the mirror of owner/name.
func (f *fixture) mirrorGit(owner, name string, args ...string) string {
	f.t.Helper()
	return runGit(f.t, "", append([]string{"--git-dir=" + f.mirrorDir(owner, name)}, args...)...)
}

// archive archives repo and unpacks the result into a new directory, which it returns with the archive's headers.
func (f *fixture) archive(repo records.Repo) (string, []*tar.Header) {
	f.t.Helper()
	var buf bytes.Buffer
	if err := f.m.Archive(context.Background(), repo, &buf); err != nil {
		f.t.Fatal(err)
	}
	dir := f.t.TempDir()
	return dir, extract(f.t, &buf, dir)
}

// extract unpacks a tar archive into dir and returns its headers.
func extract(t *testing.T, r io.Reader, dir string) []*tar.Header {
	t.Helper()
	var headers []*tar.Header
	tr := tar.NewReader(r)
	for {
		hdr, err := tr.Next()
		if err == io.EOF {
			return headers
		}
		if err != nil {
			t.Fatal(err)
		}
		headers = append(headers, hdr)
		path := filepath.Join(dir, filepath.FromSlash(hdr.Name))
		switch hdr.Typeflag {
		case tar.TypeDir:
			err = os.MkdirAll(path, 0o755)
		case tar.TypeReg:
			var data []byte
			if data, err = io.ReadAll(tr); err == nil {
				err = os.WriteFile(path, data, fs.FileMode(hdr.Mode))
			}
		case tar.TypeSymlink:
			err = os.Symlink(hdr.Linkname, path)
		default:
			t.Fatalf("entry %s has type %q", hdr.Name, hdr.Typeflag)
		}
		if err != nil {
			t.Fatal(err)
		}
	}
}
