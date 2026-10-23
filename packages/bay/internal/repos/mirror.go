package repos

import (
	"context"
	"errors"
	"fmt"
	"io/fs"
	"log/slog"
	"os"
	"os/exec"
	"path/filepath"
	"strings"

	"github.com/gshpychka/realm/packages/bay/internal/fault"
)

// mirror is one repo's bare repository and the remote it follows.
type mirror struct {
	owner, name string
	dir, remote string
	git         git
}

func (r mirror) String() string { return r.owner + "/" + r.name }

// update brings the mirror up to date with its remote, creating it first when it is missing.
func (r mirror) update(ctx context.Context) error {
	if _, err := os.Stat(r.dir); errors.Is(err, fs.ErrNotExist) {
		return r.create(ctx)
	}
	return r.fetch(ctx)
}

// create makes the mirror, which persists only once its first fetch succeeds.
func (r mirror) create(ctx context.Context) error {
	if err := os.MkdirAll(filepath.Dir(r.dir), 0o700); err != nil {
		return err
	}
	_, err := r.git.run(ctx, "", "init", "--bare", "--quiet", "--template=", "--", r.dir)
	if err == nil {
		err = r.fetch(ctx)
	}
	if err != nil {
		os.RemoveAll(r.dir)
		return err
	}
	slog.Info("mirror created", "repo", r.String())
	return nil
}

func (r mirror) fetch(ctx context.Context) error {
	// The mirror follows the remote's branches and tags, force pushes and deletions included.
	_, err := r.git.run(ctx, r.dir, "fetch", "--quiet", "--prune", "--no-write-fetch-head", r.remote,
		"+refs/heads/*:refs/heads/*", "+refs/tags/*:refs/tags/*")
	return err
}

// defaultBranch returns the branch the remote's HEAD points at.
func (r mirror) defaultBranch(ctx context.Context) (string, error) {
	out, err := r.git.run(ctx, r.dir, "ls-remote", "--symref", r.remote, "HEAD")
	if err != nil {
		return "", err
	}
	for _, line := range strings.Split(out, "\n") {
		if target, ok := strings.CutPrefix(line, "ref: refs/heads/"); ok {
			branch, _, _ := strings.Cut(target, "\t")
			return branch, nil
		}
	}
	return "", fmt.Errorf("%w: the remote has no default branch", fault.Conflict)
}

var errNoCommit = errors.New("no such commit")

// commit returns the commit rev names in the mirror, or errNoCommit when it names none.
func (r mirror) commit(ctx context.Context, rev string) (string, error) {
	out, err := r.git.run(ctx, r.dir, "rev-parse", "--verify", "--quiet", "--end-of-options", rev+"^{commit}")
	var exit *exec.ExitError
	if errors.As(err, &exit) && exit.ExitCode() == 1 {
		return "", errNoCommit
	}
	return strings.TrimSpace(out), err
}

// retain keeps a session's fixed revision reachable after a branch is deleted or
// force-pushed. Fetch prunes only heads and tags, leaving these cache refs alone.
// Like the shared mirrors themselves, these refs are cached across session removal;
// Bay currently evicts neither individual mirrors nor their retained revisions.
func (r mirror) retain(ctx context.Context, commit string) error {
	_, err := r.git.run(ctx, r.dir, "update-ref", "refs/bay/commits/"+commit, commit)
	return err
}
