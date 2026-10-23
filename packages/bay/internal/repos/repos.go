// Package repos keeps the host's mirrors of the repos sessions can access.
package repos

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"

	"github.com/gshpychka/realm/packages/bay/internal/fault"
	"github.com/gshpychka/realm/packages/bay/internal/records"
	"github.com/gshpychka/realm/packages/bay/internal/sessions"
)

var _ sessions.Repos = (*Mirrors)(nil)

// Mirrors keeps the host's copy of each repo's branches and tags.
type Mirrors struct {
	root       string
	remoteBase string
	git        git
	// locks holds a one-slot channel per mirror directory: a fetch rewrites the refs and packs an archive reads.
	locks sync.Map
}

// New returns the Mirrors kept under root, following the remotes at remoteBase + "owner/name.git".
func New(root, remoteBase string) (*Mirrors, error) {
	if remoteBase == "" {
		return nil, errors.New("repo mirrors need a remote base")
	}
	g, err := newGit(root)
	if err != nil {
		return nil, err
	}
	if err := os.MkdirAll(root, 0o700); err != nil {
		return nil, err
	}
	return &Mirrors{root: root, remoteBase: strings.TrimSuffix(remoteBase, "/") + "/", git: g}, nil
}

var (
	// repoName admits owner and repo names in GitHub's character set.
	repoName = regexp.MustCompile(`^[A-Za-z0-9_-][A-Za-z0-9._-]{0,99}$`)
	// refSyntax matches sequences git forbids in ref names, among them all of its revision syntax.
	refSyntax = regexp.MustCompile(`[\x00-\x20\x7f~^:?*\[\\]|\.\.|@\{`)
	// commitID is a commit ID from git's shortest abbreviation up to a full SHA-256.
	commitID     = regexp.MustCompile(`^[0-9a-fA-F]{4,64}$`)
	fullCommitID = regexp.MustCompile(`^([0-9a-f]{40}|[0-9a-f]{64})$`)
)

func validName(s string) bool {
	return repoName.MatchString(s) && !strings.Contains(s, "..")
}

func validRef(ref string) bool {
	return ref != "" && ref[0] != '-' && !refSyntax.MatchString(ref)
}

func (m *Mirrors) locate(owner, name string) (mirror, error) {
	if !validName(owner) {
		return mirror{}, fmt.Errorf("%w: repo owner %q", fault.Invalid, owner)
	}
	if !validName(name) {
		return mirror{}, fmt.Errorf("%w: repo name %q", fault.Invalid, name)
	}
	return mirror{
		owner:  owner,
		name:   name,
		dir:    filepath.Join(m.root, owner, name+".git"),
		remote: m.remote(owner, name),
		git:    m.git,
	}, nil
}

func (m *Mirrors) remote(owner, name string) string {
	return m.remoteBase + owner + "/" + name + ".git"
}

func (m *Mirrors) Remote(r records.Repo) string {
	return m.remote(r.Owner, r.Name)
}

// Retain protects an already cached revision from garbage collection. At startup
// the server uses it for records written before Bay began retaining commit refs.
// It does no network work; Archive can rebuild a missing mirror when needed.
func (m *Mirrors) Retain(ctx context.Context, r records.Repo) error {
	mir, err := m.locate(r.Owner, r.Name)
	if err != nil {
		return err
	}
	if !fullCommitID.MatchString(r.Commit) {
		return fmt.Errorf("%w: commit %q", fault.Invalid, r.Commit)
	}
	unlock, err := m.lock(ctx, mir)
	if err != nil {
		return err
	}
	defer unlock()
	return mir.retain(ctx, r.Commit)
}

// lock holds mir's lock until unlock is called, and fails when ctx ends first.
func (m *Mirrors) lock(ctx context.Context, mir mirror) (unlock func(), err error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	l, _ := m.locks.LoadOrStore(mir.dir, make(chan struct{}, 1))
	held := l.(chan struct{})
	select {
	case held <- struct{}{}:
		return func() { <-held }, nil
	case <-ctx.Done():
		return nil, ctx.Err()
	}
}

// Resolve returns the repo at the commit ref names on the remote now, with Branch set when ref names a branch; a ref
// that names no branch, tag or commit is a fault.Invalid.
func (m *Mirrors) Resolve(ctx context.Context, ref sessions.RepoRef) (records.Repo, error) {
	mir, err := m.locate(ref.Owner, ref.Name)
	if err != nil {
		return records.Repo{}, err
	}
	repo, err := m.resolve(ctx, mir, ref.Ref)
	if err != nil {
		return records.Repo{}, fmt.Errorf("resolve %s: %w", mir, err)
	}
	return repo, nil
}

func (m *Mirrors) resolve(ctx context.Context, mir mirror, ref string) (records.Repo, error) {
	if ref != "" && !validRef(ref) {
		return records.Repo{}, fmt.Errorf("%w: ref %q", fault.Invalid, ref)
	}
	unlock, err := m.lock(ctx, mir)
	if err != nil {
		return records.Repo{}, err
	}
	defer unlock()
	if err := mir.update(ctx); err != nil {
		return records.Repo{}, err
	}
	if ref == "" {
		branch, err := mir.defaultBranch(ctx)
		if err != nil {
			return records.Repo{}, err
		}
		if !validRef(branch) {
			return records.Repo{}, fmt.Errorf("%w: the remote's default branch %q is not a usable branch name", fault.Conflict, branch)
		}
		ref = branch
	}
	for _, l := range lookups(ref) {
		commit, err := mir.commit(ctx, l.rev)
		if errors.Is(err, errNoCommit) {
			continue
		}
		if err != nil {
			return records.Repo{}, err
		}
		if err := mir.retain(ctx, commit); err != nil {
			return records.Repo{}, err
		}
		return records.Repo{Owner: mir.owner, Name: mir.name, Branch: l.branch, Commit: commit}, nil
	}
	return records.Repo{}, fmt.Errorf("%w: no branch, tag or unambiguous commit %q", fault.Invalid, ref)
}

type lookup struct{ rev, branch string }

// lookups lists the revisions ref can name, in order of precedence.
func lookups(ref string) []lookup {
	l := []lookup{{"refs/heads/" + ref, ref}, {"refs/tags/" + ref, ""}}
	if commitID.MatchString(ref) {
		l = append(l, lookup{ref, ""})
	}
	return l
}

// Archive writes to w a tar archive whose root is a bare repository holding r.Commit; a commit the remote does not
// have is a fault.Conflict.
func (m *Mirrors) Archive(ctx context.Context, r records.Repo, w io.Writer) error {
	mir, err := m.locate(r.Owner, r.Name)
	if err != nil {
		return err
	}
	if err := m.archive(ctx, mir, r.Commit, w); err != nil {
		return fmt.Errorf("archive %s: %w", mir, err)
	}
	return nil
}

func (m *Mirrors) archive(ctx context.Context, mir mirror, commit string, w io.Writer) error {
	if !fullCommitID.MatchString(commit) {
		return fmt.Errorf("%w: commit %q", fault.Invalid, commit)
	}
	unlock, err := m.lock(ctx, mir)
	if err != nil {
		return err
	}
	defer unlock()
	_, err = mir.commit(ctx, commit)
	if err != nil {
		if err = mir.update(ctx); err != nil {
			return err
		}
		_, err = mir.commit(ctx, commit)
	}
	if errors.Is(err, errNoCommit) {
		return fmt.Errorf("%w: the remote does not have commit %s", fault.Conflict, commit)
	}
	if err != nil {
		return err
	}
	if err := mir.retain(ctx, commit); err != nil {
		return err
	}
	if err := writeTar(ctx, w, mir.dir); err != nil {
		return err
	}
	slog.Info("repo archived", "repo", mir.String(), "commit", commit)
	return nil
}

// RefreshAll fetches every mirror and returns the failures joined; a failing mirror leaves the others refreshed.
func (m *Mirrors) RefreshAll(ctx context.Context) error {
	all, err := m.existing()
	if err != nil {
		return err
	}
	errs := make([]error, len(all))
	var wg sync.WaitGroup
	for i, mir := range all {
		wg.Go(func() {
			unlock, err := m.lock(ctx, mir)
			if err == nil {
				defer unlock()
				err = mir.fetch(ctx)
			}
			if err != nil {
				errs[i] = fmt.Errorf("refresh %s: %w", mir, err)
			}
		})
	}
	wg.Wait()
	return errors.Join(errs...)
}

func (m *Mirrors) existing() ([]mirror, error) {
	owners, err := os.ReadDir(m.root)
	if err != nil {
		return nil, err
	}
	var all []mirror
	for _, owner := range owners {
		if !owner.IsDir() {
			continue
		}
		entries, err := os.ReadDir(filepath.Join(m.root, owner.Name()))
		if err != nil {
			return nil, err
		}
		for _, entry := range entries {
			name, ok := strings.CutSuffix(entry.Name(), ".git")
			if !ok || !entry.IsDir() {
				continue
			}
			if mir, err := m.locate(owner.Name(), name); err == nil {
				all = append(all, mir)
			}
		}
	}
	return all, nil
}
