package repos

import (
	"bytes"
	"context"
	"errors"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/gshpychka/realm/packages/bay/internal/fault"
	"github.com/gshpychka/realm/packages/bay/internal/records"
	"github.com/gshpychka/realm/packages/bay/internal/sessions"
)

func TestResolve(t *testing.T) {
	f := newFixture(t)
	h := seed(f.upstream("o", "n"))
	tests := []struct {
		name   string
		ref    string
		branch string
		commit string
	}{
		{"default branch", "", "main", h.second},
		{"branch", "main", "main", h.second},
		{"branch with a slash", "feature/x", "feature/x", h.feature},
		{"lightweight tag", "v1", "", h.first},
		{"annotated tag", "v2", "", h.second},
		{"full commit ID", h.first, "", h.first},
		{"abbreviated commit ID", h.first[:10], "", h.first},
		{"shortest abbreviation", h.first[:4], "", h.first},
		{"upper case abbreviation", strings.ToUpper(h.first[:10]), "", h.first},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := f.resolve("o", "n", tt.ref)
			if err != nil {
				t.Fatal(err)
			}
			want := records.Repo{Owner: "o", Name: "n", Branch: tt.branch, Commit: tt.commit}
			if got != want {
				t.Fatalf("Resolve returned %+v, want %+v", got, want)
			}
		})
	}
}

func TestResolveBranchBeatsTag(t *testing.T) {
	f := newFixture(t)
	u := f.upstream("o", "n")
	h := seed(u)
	u.git("branch", "v1", h.second)
	got, err := f.resolve("o", "n", "v1")
	if err != nil {
		t.Fatal(err)
	}
	if got.Branch != "v1" || got.Commit != h.second {
		t.Fatalf("Resolve returned %+v, want branch v1 at %s", got, h.second)
	}
}

func TestResolveUnknownRef(t *testing.T) {
	f := newFixture(t)
	seed(f.upstream("o", "n"))
	for _, ref := range []string{
		"nope",
		"feature",  // a directory of branches
		"v3",       // no such tag
		"deadbeef", // no such commit
		strings.Repeat("0", 40),
		"refs/pull/1/head", // mirrors hold branches and tags only
		"refs/heads/main",  // a ref is a branch or tag name, spelled without its namespace
		"refs/tags/v1",
		"HEAD",
		"@",
	} {
		_, err := f.resolve("o", "n", ref)
		if !errors.Is(err, fault.Invalid) {
			t.Errorf("Resolve(%q) returned %v, want fault.Invalid", ref, err)
			continue
		}
		if !strings.Contains(err.Error(), ref) || !strings.Contains(err.Error(), "o/n") {
			t.Errorf("Resolve(%q) error %q does not name the repo and the ref", ref, err)
		}
	}
}

func TestResolveRejectsInvalidInput(t *testing.T) {
	f := newFixture(t)
	seed(f.upstream("o", "n"))
	long := strings.Repeat("a", 101)
	tests := []struct{ owner, name, ref string }{
		{"", "n", ""},
		{".hidden", "n", ""},
		{"..", "n", ""},
		{"a/b", "n", ""},
		{"a..b", "n", ""},
		{"a b", "n", ""},
		{long, "n", ""},
		{"o", "", ""},
		{"o", ".hidden", ""},
		{"o", "..", ""},
		{"o", "../n", ""},
		{"o", "a..b", ""},
		{"o", long, ""},
		{"o", "n", "-x"},
		{"o", "n", "--upload-pack=touch /tmp/x"},
		{"o", "n", "a b"},
		{"o", "n", "main~1"},
		{"o", "n", "main^"},
		{"o", "n", "main^{tree}"},
		{"o", "n", "a:b"},
		{"o", "n", "a..b"},
		{"o", "n", "a@{1}"},
		{"o", "n", "a\x00b"},
		{"o", "n", "a\\b"},
		{"o", "n", "a?b"},
		{"o", "n", "a*b"},
		{"o", "n", "a[b"},
	}
	for _, tt := range tests {
		if _, err := f.resolve(tt.owner, tt.name, tt.ref); !errors.Is(err, fault.Invalid) {
			t.Errorf("Resolve(%q, %q, %q) returned %v, want fault.Invalid", tt.owner, tt.name, tt.ref, err)
		}
	}
	entries, err := os.ReadDir(f.root)
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 0 {
		t.Errorf("invalid requests left %d entries under the root", len(entries))
	}
}

func TestValidName(t *testing.T) {
	tests := []struct {
		name string
		want bool
	}{
		{"o", true},
		{"Acme", true},
		{"my-repo_2.go", true},
		{"-lead", true},
		{"_lead", true},
		{strings.Repeat("a", 100), true},
		{strings.Repeat("a", 101), false},
		{"", false},
		{".", false},
		{"..", false},
		{".git", false},
		{"a..b", false},
		{"a/b", false},
		{"a b", false},
		{"é", false},
	}
	for _, tt := range tests {
		if got := validName(tt.name); got != tt.want {
			t.Errorf("validName(%q) = %v, want %v", tt.name, got, tt.want)
		}
	}
}

func TestValidRef(t *testing.T) {
	tests := []struct {
		ref  string
		want bool
	}{
		{"main", true},
		{"feature/x", true},
		{"v1.2.3", true},
		{"release_2026-10", true},
		{"user@host", true},
		{"a+b", true},
		{"deadbeef", true},
		{"", false},
		{"-x", false},
		{"a b", false},
		{"a\tb", false},
		{"a\x7fb", false},
		{"main~1", false},
		{"main^", false},
		{"a:b", false},
		{"a..b", false},
		{"a...b", false},
		{"a@{1}", false},
		{"a\\b", false},
		{"a?b", false},
		{"a*b", false},
		{"a[b", false},
	}
	for _, tt := range tests {
		if got := validRef(tt.ref); got != tt.want {
			t.Errorf("validRef(%q) = %v, want %v", tt.ref, got, tt.want)
		}
	}
}

func TestResolveFollowsRemote(t *testing.T) {
	f := newFixture(t)
	u := f.upstream("o", "n")
	h := seed(u)
	if got, err := f.resolve("o", "n", "main"); err != nil || got.Commit != h.second {
		t.Fatalf("Resolve(main) = %+v, %v; want %s", got, err, h.second)
	}

	resolves := func(ref, commit string) {
		t.Helper()
		got, err := f.resolve("o", "n", ref)
		if err != nil || got.Commit != commit {
			t.Errorf("Resolve(%q) = %+v, %v; want %s", ref, got, err, commit)
		}
	}
	gone := func(ref string) {
		t.Helper()
		if _, err := f.resolve("o", "n", ref); !errors.Is(err, fault.Invalid) {
			t.Errorf("Resolve(%q) returned %v, want fault.Invalid", ref, err)
		}
	}

	third := u.commit("four")
	resolves(third[:12], third)
	resolves("main", third)
	resolves("", third)

	u.git("branch", "release", h.first)
	u.git("tag", "v3")
	resolves("release", h.first)
	resolves("v3", third)

	u.git("branch", "-D", "feature/x")
	u.git("tag", "-d", "v1")
	gone("feature/x")
	gone("v1")

	u.git("reset", "--quiet", "--hard", h.second)
	forced := u.commit("five")
	resolves("main", forced)

	u.git("tag", "--force", "v3", h.first)
	resolves("v3", h.first)
}

func TestResolveFollowsDefaultBranch(t *testing.T) {
	f := newFixture(t)
	u := f.upstream("o", "n")
	h := seed(u)
	if got, err := f.resolve("o", "n", ""); err != nil || got.Branch != "main" {
		t.Fatalf("Resolve returned %+v, %v; want branch main", got, err)
	}
	u.git("branch", "--move", "main", "trunk")
	got, err := f.resolve("o", "n", "")
	if err != nil {
		t.Fatal(err)
	}
	if got.Branch != "trunk" || got.Commit != h.second {
		t.Fatalf("Resolve returned %+v, want branch trunk at %s", got, h.second)
	}
}

func TestMirrorHoldsBranchesAndTags(t *testing.T) {
	f := newFixture(t)
	seed(f.upstream("o", "n"))
	if _, err := f.resolve("o", "n", ""); err != nil {
		t.Fatal(err)
	}
	got := f.mirrorGit("o", "n", "for-each-ref", "--format=%(refname)", "refs/heads", "refs/tags")
	want := "refs/heads/feature/x\nrefs/heads/main\nrefs/tags/v1\nrefs/tags/v2"
	if got != want {
		t.Fatalf("mirror holds\n%s\nwant\n%s", got, want)
	}
}

func TestResolveEmptyRemote(t *testing.T) {
	f := newFixture(t)
	f.upstream("o", "empty")
	if _, err := f.resolve("o", "empty", ""); !errors.Is(err, fault.Conflict) {
		t.Errorf("Resolve of the default branch returned %v, want fault.Conflict", err)
	}
	if _, err := f.resolve("o", "empty", "main"); !errors.Is(err, fault.Invalid) {
		t.Errorf("Resolve(main) returned %v, want fault.Invalid", err)
	}
}

func TestResolveRejectsUnusableDefaultBranch(t *testing.T) {
	f := newFixture(t)
	u := f.upstream("o", "n")
	seed(u)
	u.git("update-ref", "refs/heads/-x", "HEAD")
	u.git("symbolic-ref", "HEAD", "refs/heads/-x")
	if _, err := f.resolve("o", "n", ""); !errors.Is(err, fault.Conflict) {
		t.Errorf("Resolve of the default branch -x returned %v, want fault.Conflict", err)
	}
}

func TestResolveMissingRemote(t *testing.T) {
	f := newFixture(t)
	_, err := f.resolve("o", "missing", "")
	if err == nil || !strings.Contains(err.Error(), "o/missing") {
		t.Fatalf("Resolve returned %v, want an error naming o/missing", err)
	}
	if _, err := os.Stat(f.mirrorDir("o", "missing")); !errors.Is(err, fs.ErrNotExist) {
		t.Fatalf("a failed first fetch left a mirror behind: %v", err)
	}
}

func TestResolveHonorsContext(t *testing.T) {
	f := newFixture(t)
	seed(f.upstream("o", "n"))
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	_, err := f.m.Resolve(ctx, sessions.RepoRef{Owner: "o", Name: "n"})
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("Resolve returned %v, want context.Canceled", err)
	}
	if _, err := os.Stat(f.mirrorDir("o", "n")); !errors.Is(err, fs.ErrNotExist) {
		t.Fatalf("a cancelled Resolve left a mirror behind: %v", err)
	}
}

func TestArchive(t *testing.T) {
	f := newFixture(t)
	h := seed(f.upstream("o", "n"))
	repo, err := f.resolve("o", "n", "main")
	if err != nil {
		t.Fatal(err)
	}
	dir, headers := f.archive(repo)
	for _, hdr := range headers {
		if first, _, _ := strings.Cut(hdr.Name, "/"); first == "hooks" || first == "FETCH_HEAD" {
			t.Errorf("archive holds %s", hdr.Name)
		}
	}

	// the extracted directory clones like a bare repository
	clone := filepath.Join(t.TempDir(), "clone")
	runGit(t, "", "clone", "--quiet", "--no-checkout", dir, clone)
	runGit(t, clone, "cat-file", "-e", h.second+"^{commit}")
	for ref, commit := range map[string]string{"origin/main": h.second, "origin/feature/x": h.feature, "v1": h.first, "v2^{commit}": h.second} {
		if got := runGit(t, clone, "rev-parse", ref); got != commit {
			t.Errorf("clone has %s at %s, want %s", ref, got, commit)
		}
	}
}

func TestArchiveExtractsWithTar(t *testing.T) {
	if _, err := exec.LookPath("tar"); err != nil {
		t.Skip("tar is not on PATH")
	}
	f := newFixture(t)
	h := seed(f.upstream("o", "n"))
	repo, err := f.resolve("o", "n", "feature/x")
	if err != nil {
		t.Fatal(err)
	}
	var buf bytes.Buffer
	if err := f.m.Archive(context.Background(), repo, &buf); err != nil {
		t.Fatal(err)
	}
	dir := t.TempDir()
	untar := exec.Command("tar", "-C", dir, "-xf", "-")
	untar.Stdin = &buf
	if out, err := untar.CombinedOutput(); err != nil {
		t.Fatalf("tar: %v\n%s", err, out)
	}
	clone := filepath.Join(t.TempDir(), "clone")
	runGit(t, "", "clone", "--quiet", "--no-checkout", dir, clone)
	runGit(t, clone, "checkout", "--quiet", "-B", "feature/x", repo.Commit)
	if got := runGit(t, clone, "rev-parse", "HEAD"); got != h.feature {
		t.Errorf("clone is at %s, want %s", got, h.feature)
	}
}

func TestArchiveFetchesMissingCommit(t *testing.T) {
	f := newFixture(t)
	u := f.upstream("o", "n")
	seed(u)
	if _, err := f.resolve("o", "n", "main"); err != nil {
		t.Fatal(err)
	}
	later := u.commit("later")
	dir, _ := f.archive(records.Repo{Owner: "o", Name: "n", Branch: "main", Commit: later})
	runGit(t, "", "--git-dir="+dir, "cat-file", "-e", later+"^{commit}")
}

func TestArchiveRebuildsMissingMirror(t *testing.T) {
	f := newFixture(t)
	h := seed(f.upstream("o", "n"))
	repo, err := f.resolve("o", "n", "main")
	if err != nil {
		t.Fatal(err)
	}
	if err := os.RemoveAll(f.mirrorDir("o", "n")); err != nil {
		t.Fatal(err)
	}
	dir, _ := f.archive(repo)
	runGit(t, "", "--git-dir="+dir, "cat-file", "-e", h.second+"^{commit}")
}

func TestArchiveCommitMissingFromRemote(t *testing.T) {
	f := newFixture(t)
	seed(f.upstream("o", "n"))
	if _, err := f.resolve("o", "n", ""); err != nil {
		t.Fatal(err)
	}
	commit := strings.Repeat("ab", 20)
	var buf bytes.Buffer
	err := f.m.Archive(context.Background(), records.Repo{Owner: "o", Name: "n", Commit: commit}, &buf)
	if !errors.Is(err, fault.Conflict) {
		t.Fatalf("Archive returned %v, want fault.Conflict", err)
	}
	if !strings.Contains(err.Error(), "o/n") || !strings.Contains(err.Error(), commit) {
		t.Errorf("error %q does not name the repo and the commit", err)
	}
	if buf.Len() != 0 {
		t.Errorf("Archive wrote %d bytes for a commit it does not hold", buf.Len())
	}
}

func TestSavedCommitSurvivesBranchDeletionAndGarbageCollection(t *testing.T) {
	f := newFixture(t)
	u := f.upstream("o", "n")
	h := seed(u)
	repo, err := f.resolve("o", "n", "feature/x")
	if err != nil {
		t.Fatal(err)
	}
	u.git("branch", "-D", "feature/x")
	if err := f.m.RefreshAll(context.Background()); err != nil {
		t.Fatal(err)
	}
	f.mirrorGit("o", "n", "gc", "--prune=now")
	var archive bytes.Buffer
	if err := f.m.Archive(context.Background(), repo, &archive); err != nil {
		t.Fatalf("the saved session commit %s was lost: %v", h.feature, err)
	}
	dir := t.TempDir()
	extract(t, &archive, dir)
	runGit(t, "", "--git-dir="+dir, "cat-file", "-e", h.feature+"^{commit}")
}

func TestRetainProtectsRevisionsFromOlderRecords(t *testing.T) {
	f := newFixture(t)
	u := f.upstream("o", "n")
	h := seed(u)
	mir, err := f.m.locate("o", "n")
	if err != nil {
		t.Fatal(err)
	}
	if err := mir.update(context.Background()); err != nil {
		t.Fatal(err)
	}
	repo := records.Repo{Owner: "o", Name: "n", Commit: h.feature}
	if err := f.m.Retain(context.Background(), repo); err != nil {
		t.Fatal(err)
	}
	u.git("branch", "-D", "feature/x")
	if err := f.m.RefreshAll(context.Background()); err != nil {
		t.Fatal(err)
	}
	f.mirrorGit("o", "n", "gc", "--prune=now")
	f.archive(repo)
}

func TestArchiveRejectsInvalidRepo(t *testing.T) {
	f := newFixture(t)
	full := strings.Repeat("ab", 20)
	tests := []records.Repo{
		{Owner: "../x", Name: "n", Commit: full},
		{Owner: "o", Name: "a/b", Commit: full},
		{Owner: "o", Name: "n", Commit: ""},
		{Owner: "o", Name: "n", Commit: "main"},
		{Owner: "o", Name: "n", Commit: "abcd"},
		{Owner: "o", Name: "n", Commit: strings.ToUpper(full)},
		{Owner: "o", Name: "n", Commit: "--upload-pack=x"},
	}
	for _, r := range tests {
		var buf bytes.Buffer
		if err := f.m.Archive(context.Background(), r, &buf); !errors.Is(err, fault.Invalid) {
			t.Errorf("Archive(%+v) returned %v, want fault.Invalid", r, err)
		}
	}
}

func TestArchiveReleasesMirrorWhenCancelled(t *testing.T) {
	f := newFixture(t)
	seed(f.upstream("o", "n"))
	repo, err := f.resolve("o", "n", "main")
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	cancelOnWrite := writerFunc(func(p []byte) (int, error) {
		cancel()
		return len(p), nil
	})
	if err := f.m.Archive(ctx, repo, cancelOnWrite); !errors.Is(err, context.Canceled) {
		t.Fatalf("Archive returned %v, want context.Canceled", err)
	}
	if _, err := f.resolve("o", "n", "main"); err != nil {
		t.Fatal(err)
	}
}

type writerFunc func([]byte) (int, error)

func (w writerFunc) Write(p []byte) (int, error) { return w(p) }

// gate is a writer that blocks every write until release is closed.
type gate struct {
	once    sync.Once
	entered chan struct{}
	release chan struct{}
}

func (g *gate) Write(p []byte) (int, error) {
	g.once.Do(func() { close(g.entered) })
	<-g.release
	return len(p), nil
}

func TestArchiveHoldsMirror(t *testing.T) {
	f := newFixture(t)
	seed(f.upstream("o", "n"))
	seed(f.upstream("o", "other"))
	repo, err := f.resolve("o", "n", "main")
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()

	w := &gate{entered: make(chan struct{}), release: make(chan struct{})}
	archived := make(chan error, 1)
	go func() { archived <- f.m.Archive(ctx, repo, w) }()
	<-w.entered

	refreshed := make(chan error, 1)
	go func() { refreshed <- f.m.RefreshAll(ctx) }()
	resolvedSame := make(chan error, 1)
	go func() { _, err := f.resolve("o", "n", "main"); resolvedSame <- err }()
	resolvedOther := make(chan error, 1)
	go func() { _, err := f.resolve("o", "other", "main"); resolvedOther <- err }()

	select {
	case err := <-resolvedOther:
		if err != nil {
			t.Errorf("Resolve of another repo failed while an archive was running: %v", err)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("Resolve of another repo waited for the archive of o/n")
	}
	select {
	case err := <-refreshed:
		t.Fatalf("RefreshAll finished during the archive of o/n: %v", err)
	case err := <-resolvedSame:
		t.Fatalf("Resolve of o/n finished during its archive: %v", err)
	case <-time.After(200 * time.Millisecond):
	}

	close(w.release)
	for _, done := range []chan error{archived, refreshed, resolvedSame} {
		if err := <-done; err != nil {
			t.Error(err)
		}
	}
}

func TestWaitingForAMirrorHonorsContext(t *testing.T) {
	f := newFixture(t)
	seed(f.upstream("o", "n"))
	repo, err := f.resolve("o", "n", "main")
	if err != nil {
		t.Fatal(err)
	}
	w := &gate{entered: make(chan struct{}), release: make(chan struct{})}
	archived := make(chan error, 1)
	go func() { archived <- f.m.Archive(context.Background(), repo, w) }()
	<-w.entered

	ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
	defer cancel()
	started := time.Now()
	if _, err := f.m.Resolve(ctx, sessions.RepoRef{Owner: "o", Name: "n", Ref: "main"}); !errors.Is(err, context.DeadlineExceeded) {
		t.Errorf("Resolve behind a held mirror returned %v, want context.DeadlineExceeded", err)
	}
	var buf bytes.Buffer
	if err := f.m.Archive(ctx, repo, &buf); !errors.Is(err, context.DeadlineExceeded) {
		t.Errorf("Archive behind a held mirror returned %v, want context.DeadlineExceeded", err)
	}
	if err := f.m.RefreshAll(ctx); !errors.Is(err, context.DeadlineExceeded) {
		t.Errorf("RefreshAll behind a held mirror returned %v, want context.DeadlineExceeded", err)
	}
	if waited := time.Since(started); waited > 5*time.Second {
		t.Errorf("waiting for a held mirror took %v", waited)
	}

	close(w.release)
	if err := <-archived; err != nil {
		t.Fatal(err)
	}
	if _, err := f.resolve("o", "n", "main"); err != nil {
		t.Fatalf("the mirror stayed held: %v", err)
	}
}

func TestRefreshAll(t *testing.T) {
	f := newFixture(t)
	a, b := f.upstream("o", "a"), f.upstream("p", "b")
	seed(a)
	seed(b)
	for _, r := range [][2]string{{"o", "a"}, {"p", "b"}} {
		if _, err := f.resolve(r[0], r[1], ""); err != nil {
			t.Fatal(err)
		}
	}
	newA, newB := a.commit("a2"), b.commit("b2")
	if err := f.m.RefreshAll(context.Background()); err != nil {
		t.Fatal(err)
	}
	if got := f.mirrorGit("o", "a", "rev-parse", "refs/heads/main"); got != newA {
		t.Errorf("o/a main is %s, want %s", got, newA)
	}
	if got := f.mirrorGit("p", "b", "rev-parse", "refs/heads/main"); got != newB {
		t.Errorf("p/b main is %s, want %s", got, newB)
	}
}

func TestRefreshAllContinuesPastFailures(t *testing.T) {
	f := newFixture(t)
	a, b, c := f.upstream("o", "a"), f.upstream("o", "b"), f.upstream("o", "c")
	seed(a)
	seed(b)
	seed(c)
	for _, name := range []string{"a", "b", "c"} {
		if _, err := f.resolve("o", name, ""); err != nil {
			t.Fatal(err)
		}
	}
	newA, newC := a.commit("a2"), c.commit("c2")
	if err := os.RemoveAll(b.dir); err != nil {
		t.Fatal(err)
	}
	err := f.m.RefreshAll(context.Background())
	if err == nil || !strings.Contains(err.Error(), "refresh o/b") {
		t.Fatalf("RefreshAll returned %v, want an error for o/b", err)
	}
	if strings.Contains(err.Error(), "o/a") || strings.Contains(err.Error(), "o/c") {
		t.Errorf("RefreshAll reports healthy mirrors as failed: %v", err)
	}
	if got := f.mirrorGit("o", "a", "rev-parse", "refs/heads/main"); got != newA {
		t.Errorf("o/a main is %s, want %s", got, newA)
	}
	if got := f.mirrorGit("o", "c", "rev-parse", "refs/heads/main"); got != newC {
		t.Errorf("o/c main is %s, want %s", got, newC)
	}
}

func TestRefreshAllIgnoresStrayEntries(t *testing.T) {
	f := newFixture(t)
	if err := f.m.RefreshAll(context.Background()); err != nil {
		t.Fatalf("RefreshAll over an empty root returned %v", err)
	}
	for _, dir := range []string{".cache", "o/notes", "o/.hidden.git", "bad name/x.git"} {
		if err := os.MkdirAll(filepath.Join(f.root, dir), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	for _, file := range []string{"stray.txt", "o/file.git"} {
		if err := os.WriteFile(filepath.Join(f.root, file), nil, 0o644); err != nil {
			t.Fatal(err)
		}
	}
	if err := f.m.RefreshAll(context.Background()); err != nil {
		t.Fatalf("RefreshAll returned %v for entries that are not mirrors", err)
	}
}

func TestRemote(t *testing.T) {
	requireGit(t)
	for _, base := range []string{"https://github.com/", "https://github.com"} {
		m, err := New(t.TempDir(), base)
		if err != nil {
			t.Fatal(err)
		}
		if got := m.Remote(records.Repo{Owner: "acmeco", Name: "bay", Branch: "main", Commit: "abc"}); got != "https://github.com/acmeco/bay.git" {
			t.Errorf("Remote with base %q returned %s", base, got)
		}
	}
}

func TestNew(t *testing.T) {
	requireGit(t)
	root := filepath.Join(t.TempDir(), "a", "b")
	if _, err := New(root, "https://github.com/"); err != nil {
		t.Fatal(err)
	}
	if info, err := os.Stat(root); err != nil || !info.IsDir() {
		t.Errorf("New did not create the root: %v", err)
	}
	if _, err := New(root, ""); err == nil {
		t.Error("New accepted an empty remote base")
	}
	t.Setenv("PATH", t.TempDir())
	if _, err := New(root, "https://github.com/"); err == nil || !strings.Contains(err.Error(), "git") {
		t.Errorf("New without git on PATH returned %v", err)
	}
}
