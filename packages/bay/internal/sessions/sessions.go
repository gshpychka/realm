// Package sessions runs sessions: it starts them from their records, suspends, resumes, snapshots, ends and
// removes them.
package sessions

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"log/slog"
	"regexp"
	"slices"
	"strings"
	"sync"
	"time"

	"github.com/gshpychka/realm/packages/bay/internal/fault"
	"github.com/gshpychka/realm/packages/bay/internal/guest"
	"github.com/gshpychka/realm/packages/bay/internal/identity"
	"github.com/gshpychka/realm/packages/bay/internal/machines"
	"github.com/gshpychka/realm/packages/bay/internal/records"
)

// State is where a session is in its lifecycle.
type State string

const (
	Running   State = "running"
	Suspended State = "suspended"
	Ended     State = "ended"
)

// Session is a session's record with its current state.
type Session struct {
	records.Record
	State       State
	Connectable bool
	// Snapshots are the instance's snapshots, oldest first.
	Snapshots []string
}

// Program is a program definition.
type Program struct {
	Command []string
	// Resume continues the program from its history; empty means Command.
	Resume []string
	// History are clean paths below the program's home that hold its history.
	History []string
	// Monitor alerts the operator on a terminal bell or a long silence.
	Monitor bool
	// Connect is a predefined command that opens the program's persistent endpoint.
	// It runs as the session user, separately from the program itself.
	Connect []string
	Machine string
	// MaxConnections defaults to one. All bridges are bounded and closed together.
	MaxConnections int
}

// Status is the state of a session's instance.
type Status int

const (
	InstanceAbsent Status = iota
	InstanceStopped
	InstanceRunning
)

// Instances are the VMs backing sessions, each named after its session; names are DNS labels.
type Instances interface {
	// Create clones the warm base into a stopped instance that carries sessionID.
	Create(ctx context.Context, name, sessionID string, machine *machines.Selection) error
	// Start boots the instance, restoring its memory when it has saved memory, and returns once its guest takes
	// commands. restored reports whether memory was restored.
	Start(ctx context.Context, name string) (restored bool, err error)
	// Suspend stops the instance with its memory saved.
	Suspend(ctx context.Context, name string) error
	// Delete removes the instance with its snapshots, whatever its state.
	Delete(ctx context.Context, name string) error
	Status(ctx context.Context, name string) (Status, error)
	// Statuses returns the status of every instance backing a session, by name.
	Statuses(ctx context.Context) (map[string]Status, error)
	// Snapshot saves the running instance's disk and memory as a new snapshot called snapshot.
	Snapshot(ctx context.Context, name, snapshot string) error
	// Snapshots returns the instance's snapshots, oldest first.
	Snapshots(ctx context.Context, name string) ([]string, error)
	// Restore rolls the instance back to snapshot, deleting the snapshots taken after it, and returns once it runs
	// from it.
	Restore(ctx context.Context, name, snapshot string) error
	// Exec runs argv in the instance's guest as root; a non-zero exit is an error.
	Exec(ctx context.Context, name string, argv []string, stdin io.Reader, stdout io.Writer) error
	// Connect runs a cancellable bridge, bound to the instance's session ID.
	Connect(ctx context.Context, name, sessionID string, argv []string, stdin io.Reader, stdout io.Writer) error
	// Caller returns the name and session ID of the running instance whose vsock context ID is cid.
	Caller(ctx context.Context, cid uint32) (name, sessionID string, err error)
	// AttachCommand is the host command that runs argv in the instance attached to the caller's terminal.
	AttachCommand(name string, argv []string) []string
}

// RepoRef names a repo and the ref to check out; an empty Ref means the default branch.
type RepoRef struct {
	Owner, Name, Ref string
}

// Repos are the host's mirrors of the repos sessions can access.
type Repos interface {
	// Resolve returns the repo with the commit ref points at.
	Resolve(ctx context.Context, ref RepoRef) (records.Repo, error)
	// Archive writes a tar archive of a bare repository holding r.Commit to w.
	Archive(ctx context.Context, r records.Repo, w io.Writer) error
	// Remote is the URL a session's clone of r fetches from and pushes to.
	Remote(r records.Repo) string
}

// Config is what a Service runs with.
type Config struct {
	Programs map[string]Program
	Machines map[string]machines.Definition
	// MaxRunning caps the sessions running at once; it is at least 1.
	MaxRunning int
	// MaxMemory caps the sum of admitted memory limits in GiB; zero is legacy count-only admission.
	MaxMemory int
	// Reserved are names no session can take.
	Reserved []string
}

// Service runs sessions.
type Service struct {
	records   *records.Store
	instances Instances
	repos     Repos
	config    Config
	log       *slog.Logger
	// maxHistory bounds the saved program history of one session, in bytes.
	maxHistory int64

	mu sync.Mutex
	// busy holds the sessions with an operation in flight.
	busy map[string]bool
	// starting holds the sessions with a running slot reserved.
	starting map[string]int
	// connections holds the live bridges cancelled before lifecycle changes.
	connections map[string]map[*programConnection]struct{}
}

// New returns a Service over the given store, instances and repos, or an error for a Config that breaks the
// constraints its fields state.
func New(store *records.Store, instances Instances, repos Repos, config Config, log *slog.Logger) (*Service, error) {
	if config.MaxRunning < 1 {
		return nil, fmt.Errorf("max running sessions must be at least 1, not %d", config.MaxRunning)
	}
	if config.MaxMemory < 0 || (config.MaxMemory > 0 && len(config.Machines) == 0) {
		return nil, errors.New("memory admission needs a non-negative budget and a machine catalog")
	}
	if err := machines.ValidateCatalog(config.Machines); err != nil {
		return nil, err
	}
	for name, program := range config.Programs {
		if name == "" {
			return nil, errors.New("program definitions need a name")
		}
		if err := validCommand(program.Command); err != nil || len(program.Command) == 0 {
			return nil, fmt.Errorf("program %s: command must name an executable and contain no NUL bytes", name)
		}
		if err := validCommand(program.Resume); err != nil {
			return nil, fmt.Errorf("program %s: resume: %w", name, err)
		}
		if err := validCommand(program.Connect); err != nil {
			return nil, fmt.Errorf("program %s: connect: %w", name, err)
		}
		if program.MaxConnections < 0 {
			return nil, fmt.Errorf("program %s: maxConnections must be positive", name)
		}
		if program.Machine != "" || len(config.Machines) > 0 {
			key := program.Machine
			if key == "" {
				key = machines.Default
			}
			if _, ok := config.Machines[key]; !ok {
				return nil, fmt.Errorf("program %s: undeclared machine %q", name, key)
			}
		}
		for _, path := range program.History {
			if path == "." || !fs.ValidPath(path) || strings.ContainsRune(path, '\x00') {
				return nil, fmt.Errorf("program %s: history path %q must be a clean path below the program's home", name, path)
			}
		}
	}
	return &Service{
		records:     store,
		instances:   instances,
		repos:       repos,
		config:      config,
		log:         log,
		maxHistory:  2 << 30,
		busy:        map[string]bool{},
		starting:    map[string]int{},
		connections: map[string]map[*programConnection]struct{}{},
	}, nil
}

// operationTimeout bounds one operation.
const operationTimeout = 15 * time.Minute

// StartSpec describes a new session.
type StartSpec struct {
	Expected        identity.Precondition
	MachineRevision string
	// Program names a program definition. With neither Program nor Command the session runs a login shell.
	Program string
	Command []string
	// Repos has at most one entry per owner and name.
	Repos []RepoRef
}

func (s StartSpec) empty() bool {
	return s.Program == "" && len(s.Command) == 0 && len(s.Repos) == 0
}

// Start starts the ended session named name again from its record when spec is empty, or, when no session has that
// name, a new one from spec. A non-empty spec for a name that has a record is a conflict.
func (s *Service) Start(ctx context.Context, name string, spec StartSpec) (Session, error) {
	ctx, cancel := detach(ctx)
	defer cancel()
	release, err := s.claimSession(name, false)
	if err != nil {
		return Session{}, err
	}
	defer release()

	rec, err := s.record(name)
	fresh := errors.Is(err, fault.NotFound)
	if err != nil && !fresh {
		return Session{}, err
	}
	if fresh && (spec.Expected.ID != "" || spec.Expected.Generation != nil) {
		return Session{}, fmt.Errorf("%w: expected session %s does not exist", fault.Conflict, name)
	}
	if !fresh {
		if err := checkExpected(rec, []identity.Precondition{spec.Expected}); err != nil {
			return Session{}, err
		}
	}
	s.disconnectConnections(name)
	memory := s.machineMemory(rec)
	if fresh || rec.Machine == nil {
		program := rec.Program.Definition
		if fresh {
			program = spec.Program
		}
		machine, err := s.selectMachine(program, spec.MachineRevision)
		if err != nil {
			if fresh {
				err = rejectedLaunch(err)
			}
			return Session{}, err
		}
		if machine != nil {
			memory = machine.Resources.Memory
		}
	}
	unreserve, err := s.reserve(ctx, name, memory)
	if err != nil {
		return Session{}, err
	}
	defer unreserve()

	switch {
	case fresh:
		if rec, err = s.newRecord(ctx, name, spec); err != nil {
			return Session{}, err
		}
	case err != nil:
		return Session{}, err
	case !spec.empty():
		return Session{}, fmt.Errorf("%w: session %s exists; start it again without a program, command or repos", fault.Conflict, name)
	default:
		status, err := s.instances.Status(ctx, name)
		if err != nil {
			return Session{}, err
		}
		if status != InstanceAbsent {
			return Session{}, fmt.Errorf("%w: session %s has not ended", fault.Conflict, name)
		}
		if rec.Machine == nil && len(s.config.Machines) > 0 {
			machine, err := s.selectMachine(rec.Program.Definition, spec.MachineRevision)
			if err != nil {
				return Session{}, err
			}
			program, err := s.program(rec)
			if err != nil {
				return Session{}, err
			}
			if rec, err = s.records.PinMachine(name, *machine, snapshotProgram(program)); err != nil {
				return Session{}, err
			}
		}
		if spec.MachineRevision != "" && (rec.Machine == nil || rec.Machine.Revision != spec.MachineRevision) {
			return Session{}, fmt.Errorf("%w: session %s is pinned to a different machine revision", fault.Conflict, name)
		}
	}
	if !fresh {
		if rec, err = s.records.AdvanceGeneration(name); err != nil {
			return Session{}, err
		}
	}
	if err := s.boot(ctx, rec, fresh); err != nil {
		s.rollback(rec, fresh)
		return Session{}, err
	}
	s.log.Info("session started", "session", name, "program", describe(rec.Program), "repos", len(rec.Repos), "fresh", fresh)
	return s.get(ctx, name, false)
}

func (s *Service) newRecord(ctx context.Context, name string, spec StartSpec) (records.Record, error) {
	rec, err := s.prepareRecord(ctx, name, spec)
	if err != nil {
		return records.Record{}, rejectedLaunch(err)
	}
	// Once persistence begins, a failure is no longer proof that this session never existed.
	if err := s.records.Create(rec); err != nil {
		if errors.Is(err, records.ErrExists) {
			return records.Record{}, fmt.Errorf("%w: session %s exists", fault.Conflict, name)
		}
		return records.Record{}, err
	}
	return rec, nil
}

// prepareRecord validates and resolves a fresh declaration without creating its session record or instance.
func (s *Service) prepareRecord(ctx context.Context, name string, spec StartSpec) (records.Record, error) {
	if err := s.validName(name); err != nil {
		return records.Record{}, err
	}
	if spec.Program != "" && len(spec.Command) > 0 {
		return records.Record{}, fmt.Errorf("%w: give a program or a command, not both", fault.Invalid)
	}
	if err := validCommand(spec.Command); err != nil {
		return records.Record{}, fmt.Errorf("%w: %v", fault.Invalid, err)
	}
	if spec.Program != "" {
		if _, ok := s.config.Programs[spec.Program]; !ok {
			return records.Record{}, fmt.Errorf("%w: no program definition named %q", fault.Invalid, spec.Program)
		}
	}
	machine, err := s.selectMachine(spec.Program, spec.MachineRevision)
	if err != nil {
		return records.Record{}, err
	}
	seen := map[[2]string]bool{}
	for _, ref := range spec.Repos {
		key := [2]string{ref.Owner, ref.Name}
		if seen[key] {
			return records.Record{}, fmt.Errorf("%w: repo %s/%s is given more than once", fault.Invalid, ref.Owner, ref.Name)
		}
		seen[key] = true
	}
	rec := records.Record{
		ID:         newID(),
		Generation: 1,
		Name:       name,
		Program:    records.Program{Definition: spec.Program, Command: spec.Command},
		Machine:    machine,
		Created:    time.Now().UTC(),
	}
	if machine != nil {
		program, err := s.program(rec)
		if err != nil {
			return records.Record{}, err
		}
		rec.Program.Runtime = snapshotProgram(program)
	}
	for _, ref := range spec.Repos {
		repo, err := s.repos.Resolve(ctx, ref)
		if err != nil {
			return records.Record{}, err
		}
		rec.Repos = append(rec.Repos, repo)
	}
	return rec, nil
}

// rejectedLaunch is only used before any record or instance creation was attempted. Infrastructure failures keep
// their uncertain outcome; only deterministic declaration and repository validation refusals are terminal.
func rejectedLaunch(err error) error {
	if fault.Code(err) != "" {
		return err
	}
	if kind := fault.Kind(err); kind == fault.Invalid || kind == fault.Conflict {
		return fault.WithCode(err, fault.LaunchRejectedCode)
	}
	return err
}

// boot brings up an instance for rec and launches its program, with its history when it starts again.
func (s *Service) boot(ctx context.Context, rec records.Record, fresh bool) error {
	program, err := s.program(rec)
	if err != nil {
		return err
	}
	if err := s.instances.Create(ctx, rec.Name, rec.ID, rec.Machine); err != nil {
		return err
	}
	if _, err := s.instances.Start(ctx, rec.Name); err != nil {
		return err
	}
	g := s.guest(rec.Name)
	if err := g.Ready(ctx); err != nil {
		return err
	}
	for _, repo := range rec.Repos {
		if err := s.deliver(ctx, g, repo); err != nil {
			return err
		}
	}
	argv := program.Command
	if !fresh && len(program.History) > 0 {
		restored, err := s.restoreHistory(ctx, g, rec.Name)
		if err != nil {
			return err
		}
		if restored {
			argv = program.resume()
		}
	}
	return g.Launch(ctx, argv, program.Monitor)
}

func (s *Service) deliver(ctx context.Context, g guest.Guest, repo records.Repo) error {
	r, w := io.Pipe()
	archived := make(chan error, 1)
	go func() {
		err := s.repos.Archive(ctx, repo, w)
		w.CloseWithError(err)
		archived <- err
	}()
	err := g.DeliverRepo(ctx, guest.Checkout{
		Owner:  repo.Owner,
		Name:   repo.Name,
		Branch: repo.Branch,
		Commit: repo.Commit,
		Remote: s.repos.Remote(repo),
	}, r)
	r.CloseWithError(err)
	// a failing archive reaches the guest only as a cut-short stream, so its own error is the cause
	if archiveErr := <-archived; archiveErr != nil && (err == nil || !errors.Is(archiveErr, err)) {
		err = archiveErr
	}
	if err != nil {
		return fmt.Errorf("deliver %s/%s: %w", repo.Owner, repo.Name, err)
	}
	return nil
}

func (s *Service) restoreHistory(ctx context.Context, g guest.Guest, name string) (bool, error) {
	history, err := s.records.History(name)
	if errors.Is(err, records.ErrNotFound) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	defer history.Close()
	if err := g.RestoreHistory(ctx, history); err != nil {
		return false, err
	}
	return true, nil
}

// rollback undoes a failed start: the instance goes, and once it has, so does the record of a session that never ran.
func (s *Service) rollback(rec records.Record, fresh bool) {
	ctx, cancel := context.WithTimeout(context.Background(), operationTimeout)
	defer cancel()
	if err := s.instances.Delete(ctx, rec.Name); err != nil {
		s.log.Error("roll back start: delete instance", "session", rec.Name, "err", err)
		// an instance is reached through its record
		return
	}
	if fresh {
		if err := s.records.Delete(rec.Name); err != nil {
			s.log.Error("roll back start: delete record", "session", rec.Name, "err", err)
		}
	}
}

// Suspend saves a running session's disk and memory and stops its instance. An optional precondition binds the
// operation to its record and execution before any program connection is interrupted.
func (s *Service) Suspend(ctx context.Context, name string, expected ...identity.Precondition) error {
	ctx, cancel := detach(ctx)
	defer cancel()
	release, err := s.claimSession(name, false)
	if err != nil {
		return err
	}
	defer release()
	rec, err := s.record(name)
	if err != nil {
		return err
	}
	if err := checkExpected(rec, expected); err != nil {
		return err
	}
	s.disconnectConnections(name)
	if err := s.require(ctx, name, InstanceRunning); err != nil {
		return err
	}
	if err := s.instances.Suspend(ctx, name); err != nil {
		return err
	}
	s.log.Info("session suspended", "session", name)
	return nil
}

// Resume continues a suspended session where it was, starts the program again in a running session whose program has
// stopped or, given a snapshot, rolls a session back to it. Rolling back deletes the snapshots taken after it, and
// discard must name exactly those.
func (s *Service) Resume(ctx context.Context, name, snapshot string, discard []string, expected ...identity.Precondition) error {
	ctx, cancel := detach(ctx)
	defer cancel()
	release, err := s.claimSession(name, false)
	if err != nil {
		return err
	}
	defer release()
	rec, err := s.record(name)
	if err != nil {
		return err
	}
	if err := checkExpected(rec, expected); err != nil {
		return err
	}
	s.disconnectConnections(name)
	status, err := s.instances.Status(ctx, name)
	if err != nil {
		return err
	}
	if status == InstanceAbsent {
		return fmt.Errorf("%w: session %s has ended; start it instead", fault.Conflict, name)
	}
	if snapshot == "" && status == InstanceRunning {
		return s.relaunchStopped(ctx, rec)
	}
	unreserve, err := s.reserve(ctx, name, s.machineMemory(rec))
	if err != nil {
		return err
	}
	defer unreserve()
	if snapshot != "" {
		snapshots, err := s.instances.Snapshots(ctx, name)
		if err != nil {
			return err
		}
		at := slices.Index(snapshots, snapshot)
		if at < 0 {
			return fmt.Errorf("%w: session %s has no snapshot %s", fault.NotFound, name, snapshot)
		}
		if later := snapshots[at+1:]; !sameSet(later, discard) {
			return fmt.Errorf("%w: rolling session %s back to %s deletes snapshots %s", fault.Conflict, name, snapshot, list(later))
		}
		if _, err = s.records.AdvanceGeneration(name); err != nil {
			return err
		}
		if err := s.instances.Restore(ctx, name, snapshot); err != nil {
			return err
		}
		s.log.Info("session rolled back", "session", name, "snapshot", snapshot)
		return nil
	}
	if rec, err = s.records.AdvanceGeneration(name); err != nil {
		return err
	}
	restored, err := s.instances.Start(ctx, name)
	if err != nil {
		return err
	}
	if !restored {
		g := s.guest(name)
		if err := g.Ready(ctx); err != nil {
			return err
		}
		if err := s.relaunch(ctx, g, rec); err != nil {
			return err
		}
	}
	s.log.Info("session resumed", "session", name, "restored", restored)
	return nil
}

// relaunchStopped starts the program again in a running session whose program has stopped; a program that runs is a
// conflict.
func (s *Service) relaunchStopped(ctx context.Context, rec records.Record) error {
	g := s.guest(rec.Name)
	if err := g.Ready(ctx); err != nil {
		return err
	}
	running, err := g.Running(ctx)
	if err != nil {
		return err
	}
	if running {
		return fmt.Errorf("%w: session %s is running", fault.Conflict, rec.Name)
	}
	if rec, err = s.records.AdvanceGeneration(rec.Name); err != nil {
		return err
	}
	if err := s.relaunch(ctx, g, rec); err != nil {
		return err
	}
	s.log.Info("session program relaunched", "session", rec.Name)
	return nil
}

// relaunch starts the program again in an instance that lost it; the program's history is still on the instance's
// disk.
func (s *Service) relaunch(ctx context.Context, g guest.Guest, rec records.Record) error {
	program, err := s.program(rec)
	if err != nil {
		return err
	}
	argv := program.Command
	if len(program.History) > 0 {
		argv = program.resume()
	}
	return g.Launch(ctx, argv, program.Monitor)
}

// Snap saves a running session's disk and memory as a snapshot and returns its name.
func (s *Service) Snap(ctx context.Context, name, snapshot string, expected ...identity.Precondition) (string, error) {
	ctx, cancel := detach(ctx)
	defer cancel()
	release, err := s.claimSession(name, false)
	if err != nil {
		return "", err
	}
	defer release()
	rec, err := s.record(name)
	if err != nil {
		return "", err
	}
	if err := checkExpected(rec, expected); err != nil {
		return "", err
	}
	s.disconnectConnections(name)
	if err := s.require(ctx, name, InstanceRunning); err != nil {
		return "", err
	}
	if snapshot != "" && !snapshotName.MatchString(snapshot) {
		return "", fmt.Errorf("%w: snapshot names are letters and digits, with dots, underscores and hyphens between: %q", fault.Invalid, snapshot)
	}
	existing, err := s.instances.Snapshots(ctx, name)
	if err != nil {
		return "", err
	}
	if snapshot == "" {
		base := time.Now().UTC().Format("20060102-150405")
		snapshot = base
		for suffix := 2; slices.Contains(existing, snapshot); suffix++ {
			snapshot = fmt.Sprintf("%s-%d", base, suffix)
		}
	}
	if slices.Contains(existing, snapshot) {
		return "", fmt.Errorf("%w: session %s has a snapshot %s", fault.Conflict, name, snapshot)
	}
	if err := s.instances.Snapshot(ctx, name, snapshot); err != nil {
		return "", err
	}
	s.log.Info("session snapshotted", "session", name, "snapshot", snapshot)
	return snapshot, nil
}

// End saves the program's history into the session's record and deletes its instance with its snapshots.
// acknowledged must name exactly the session's snapshots.
func (s *Service) End(ctx context.Context, name string, acknowledged []string, expected ...identity.Precondition) error {
	ctx, cancel := detach(ctx)
	defer cancel()
	release, err := s.claimSession(name, false)
	if err != nil {
		return err
	}
	defer release()
	rec, err := s.record(name)
	if err != nil {
		return err
	}
	if err := checkExpected(rec, expected); err != nil {
		return err
	}
	s.disconnectConnections(name)
	status, err := s.instances.Status(ctx, name)
	if err != nil {
		return err
	}
	if status == InstanceAbsent {
		return fmt.Errorf("%w: session %s has ended", fault.Conflict, name)
	}
	snapshots, err := s.instances.Snapshots(ctx, name)
	if err != nil {
		return err
	}
	if !sameSet(snapshots, acknowledged) {
		return fmt.Errorf("%w: session %s has snapshots %s, and ending deletes them", fault.Conflict, name, list(snapshots))
	}
	program, err := s.program(rec)
	if err != nil {
		return err
	}
	if len(program.History) > 0 {
		if status == InstanceStopped {
			unreserve, err := s.reserve(ctx, name, s.machineMemory(rec))
			if err != nil {
				return err
			}
			defer unreserve()
			if _, err := s.instances.Start(ctx, name); err != nil {
				return err
			}
		}
		if err := s.saveHistory(ctx, rec.Name, program.History); err != nil {
			return err
		}
	}
	if err := s.instances.Delete(ctx, name); err != nil {
		return err
	}
	s.log.Info("session ended", "session", name, "snapshots deleted", len(snapshots))
	return nil
}

func (s *Service) saveHistory(ctx context.Context, name string, paths []string) error {
	g := s.guest(name)
	if err := g.Ready(ctx); err != nil {
		return err
	}
	if err := g.Stop(ctx); err != nil {
		return err
	}
	r, w := io.Pipe()
	go func() { w.CloseWithError(g.SaveHistory(ctx, paths, w)) }()
	err := s.records.WriteHistory(name, &cappedReader{r: r, limit: s.maxHistory})
	r.CloseWithError(err)
	if err != nil {
		return fmt.Errorf("save history: %w", err)
	}
	return nil
}

// Remove deletes a session's instance, its record and its history.
func (s *Service) Remove(ctx context.Context, name string, expected ...identity.Precondition) error {
	ctx, cancel := detach(ctx)
	defer cancel()
	release, err := s.claimSession(name, false)
	if err != nil {
		return err
	}
	defer release()
	rec, err := s.record(name)
	if err != nil {
		return err
	}
	if err := checkExpected(rec, expected); err != nil {
		return err
	}
	s.disconnectConnections(name)
	if err := s.instances.Delete(ctx, name); err != nil {
		return err
	}
	if err := s.records.Delete(name); err != nil {
		return err
	}
	s.log.Info("session removed", "session", name)
	return nil
}

// AttachCommand returns the host command that attaches the caller's terminal to a running session's program.
func (s *Service) AttachCommand(ctx context.Context, name string) ([]string, error) {
	if err := s.require(ctx, name, InstanceRunning); err != nil {
		return nil, err
	}
	return s.instances.AttachCommand(name, guest.AttachCommand()), nil
}

// Get returns a session with its snapshots.
func (s *Service) Get(ctx context.Context, name string) (Session, error) {
	return s.get(ctx, name, true)
}

func (s *Service) get(ctx context.Context, name string, snapshots bool) (Session, error) {
	rec, err := s.record(name)
	if err != nil {
		return Session{}, err
	}
	status, err := s.instances.Status(ctx, name)
	if err != nil {
		return Session{}, err
	}
	session := Session{Record: rec, State: state(status), Connectable: s.connectable(rec)}
	if snapshots && status != InstanceAbsent {
		if session.Snapshots, err = s.instances.Snapshots(ctx, name); err != nil {
			return Session{}, err
		}
	}
	return session, nil
}

// List returns every session, oldest first, without its snapshots.
func (s *Service) List(ctx context.Context) ([]Session, error) {
	recs, err := s.records.List()
	if err != nil {
		return nil, err
	}
	statuses, err := s.instances.Statuses(ctx)
	if err != nil {
		return nil, err
	}
	sessions := make([]Session, 0, len(recs))
	for _, rec := range recs {
		sessions = append(sessions, Session{Record: rec, State: state(statuses[rec.Name]), Connectable: s.connectable(rec)})
	}
	return sessions, nil
}

// Caller returns the record of the running session whose instance has the vsock context ID cid.
func (s *Service) Caller(ctx context.Context, cid uint32) (records.Record, error) {
	name, sessionID, err := s.instances.Caller(ctx, cid)
	if err != nil {
		return records.Record{}, err
	}
	rec, err := s.record(name)
	if err != nil {
		return records.Record{}, err
	}
	if rec.ID != sessionID {
		return records.Record{}, fmt.Errorf("%w: instance %s belongs to an earlier session", fault.NotFound, name)
	}
	return rec, nil
}

// Lookup returns the record of the session named name, whatever its state.
func (s *Service) Lookup(name string) (records.Record, error) {
	return s.record(name)
}

func (s *Service) record(name string) (records.Record, error) {
	// every record is created under a name sessionName admits
	if sessionName.MatchString(name) {
		rec, err := s.records.Get(name)
		if !errors.Is(err, records.ErrNotFound) {
			return rec, err
		}
	}
	return records.Record{}, fmt.Errorf("%w: no session named %s", fault.NotFound, name)
}

func checkExpected(rec records.Record, expected []identity.Precondition) error {
	if len(expected) == 0 {
		return nil
	}
	return expected[0].Check(identity.Session{ID: rec.ID, Name: rec.Name, Generation: rec.Generation})
}

func (s *Service) require(ctx context.Context, name string, want Status) error {
	if _, err := s.record(name); err != nil {
		return err
	}
	status, err := s.instances.Status(ctx, name)
	if err != nil {
		return err
	}
	if status != want {
		return fmt.Errorf("%w: session %s is %s", fault.Conflict, name, state(status))
	}
	return nil
}

func (s *Service) program(rec records.Record) (Program, error) {
	if p := rec.Program.Runtime; p != nil {
		return Program{Command: p.Command, Resume: p.Resume, History: p.History, Monitor: p.Monitor, Connect: p.Connect, MaxConnections: p.MaxConnections}, nil
	}
	if rec.Program.Definition == "" {
		// only a program definition turns terminal alerts off
		return Program{Command: rec.Program.Command, Monitor: true}, nil
	}
	program, ok := s.config.Programs[rec.Program.Definition]
	if !ok {
		return Program{}, fmt.Errorf("%w: session %s runs %q, which has no program definition", fault.Conflict, rec.Name, rec.Program.Definition)
	}
	return program, nil
}

func snapshotProgram(p Program) *records.ProgramDefinition {
	return &records.ProgramDefinition{Command: p.Command, Resume: p.Resume, History: p.History, Monitor: p.Monitor, Connect: p.Connect, MaxConnections: p.MaxConnections}
}

func (s *Service) selectMachine(program, expected string) (*machines.Selection, error) {
	if len(s.config.Machines) == 0 {
		if expected != "" {
			return nil, fmt.Errorf("%w: no machine revisions are declared", fault.Conflict)
		}
		return nil, nil
	}
	name := s.config.Programs[program].Machine
	if name == "" {
		name = machines.Default
	}
	machine, ok := s.config.Machines[name]
	if !ok {
		return nil, fmt.Errorf("%w: undeclared machine %q", fault.Invalid, name)
	}
	if expected != "" && machine.Revision != expected {
		return nil, fmt.Errorf("%w: program's machine revision changed; reload its catalog", fault.Conflict)
	}
	return &machines.Selection{Name: name, Definition: machine}, nil
}

func (s *Service) connectable(rec records.Record) bool {
	p, err := s.program(rec)
	return err == nil && len(p.Connect) > 0
}

func (p Program) resume() []string {
	if len(p.Resume) > 0 {
		return p.Resume
	}
	return p.Command
}

func validCommand(argv []string) error {
	if len(argv) > 0 && argv[0] == "" {
		return errors.New("command must name an executable")
	}
	for _, arg := range argv {
		if strings.ContainsRune(arg, '\x00') {
			return errors.New("command arguments must not contain NUL bytes")
		}
	}
	return nil
}

func (s *Service) guest(name string) guest.Guest {
	return guest.New(func(ctx context.Context, argv []string, stdin io.Reader, stdout io.Writer) error {
		return s.instances.Exec(ctx, name, argv, stdin, stdout)
	})
}

// claim marks name busy until release is called; a second operation on the same session meanwhile is a conflict.
func (s *Service) claim(name string) (release func(), err error) {
	return s.claimSession(name, true)
}

func (s *Service) claimSession(name string, disconnect bool) (release func(), err error) {
	s.mu.Lock()
	if s.busy[name] {
		s.mu.Unlock()
		return nil, fmt.Errorf("%w: another operation on session %s is in progress", fault.Conflict, name)
	}
	s.busy[name] = true
	s.mu.Unlock()
	// A bridge must leave the old instance before an operation can replace it or
	// roll it back. The program is independent of this short-lived connection.
	if disconnect {
		s.disconnectConnections(name)
	}
	return func() {
		s.mu.Lock()
		delete(s.busy, name)
		s.mu.Unlock()
	}, nil
}

func (s *Service) disconnectConnections(name string) {
	s.mu.Lock()
	connections := make([]*programConnection, 0, len(s.connections[name]))
	for connection := range s.connections[name] {
		connections = append(connections, connection)
	}
	s.mu.Unlock()
	for _, connection := range connections {
		connection.Close()
	}
	for _, connection := range connections {
		<-connection.done
	}
}

// reserve holds a running slot for the session named name until release is called.
func (s *Service) reserve(ctx context.Context, name string, memory int) (release func(), err error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	statuses, err := s.instances.Statuses(ctx)
	if err != nil {
		return nil, err
	}
	// every other session holding a slot counts once, whether or not its instance runs yet
	running := len(s.starting)
	usedMemory := 0
	for _, reserved := range s.starting {
		usedMemory += reserved
	}
	for other, status := range statuses {
		_, starting := s.starting[other]
		if status == InstanceRunning && other != name && !starting {
			running++
			if s.config.MaxMemory > 0 {
				rec, err := s.record(other)
				if err != nil {
					return nil, err
				}
				usedMemory += s.machineMemory(rec)
			}
		}
	}
	if running >= s.config.MaxRunning {
		return nil, fmt.Errorf("%w: %d of %d sessions are running", fault.Capacity, running, s.config.MaxRunning)
	}
	if s.config.MaxMemory > 0 && usedMemory+memory > s.config.MaxMemory {
		return nil, fmt.Errorf("%w: %d of %d GiB is admitted; session %s needs %d GiB", fault.Capacity, usedMemory, s.config.MaxMemory, name, memory)
	}
	s.starting[name] = memory
	return func() {
		s.mu.Lock()
		delete(s.starting, name)
		s.mu.Unlock()
	}, nil
}

func (s *Service) machineMemory(rec records.Record) int {
	if rec.Machine != nil {
		return rec.Machine.Resources.Memory
	}
	return s.config.Machines[machines.Default].Resources.Memory
}

var (
	// sessionName admits the DNS labels Instances take as names.
	sessionName = regexp.MustCompile(`^[a-z]([a-z0-9-]{0,61}[a-z0-9])?$`)
	// snapshotName admits the names Instances take for snapshots.
	snapshotName = regexp.MustCompile(`^[A-Za-z0-9]([A-Za-z0-9._-]{0,61}[A-Za-z0-9])?$`)
)

func (s *Service) validName(name string) error {
	if !sessionName.MatchString(name) {
		return fmt.Errorf("%w: session names are 1–63 lowercase letters, digits and hyphens, starting with a letter and ending with a letter or digit: %q", fault.Invalid, name)
	}
	if slices.Contains(s.config.Reserved, name) {
		return fmt.Errorf("%w: %q is reserved", fault.Invalid, name)
	}
	if strings.HasPrefix(name, machines.BasePrefix) {
		return fmt.Errorf("%w: names starting with %q are reserved", fault.Invalid, machines.BasePrefix)
	}
	return nil
}

func state(status Status) State {
	switch status {
	case InstanceRunning:
		return Running
	case InstanceStopped:
		return Suspended
	default:
		return Ended
	}
}

func describe(p records.Program) string {
	if p.Definition != "" {
		return p.Definition
	}
	return strings.Join(p.Command, " ")
}

func sameSet(a, b []string) bool {
	a, b = slices.Clone(a), slices.Clone(b)
	slices.Sort(a)
	slices.Sort(b)
	return slices.Equal(slices.Compact(a), slices.Compact(b))
}

func list(names []string) string {
	if len(names) == 0 {
		return "(none)"
	}
	return strings.Join(names, ", ")
}

// newID returns a random 64-bit ID, distinct from every earlier session's.
func newID() string {
	b := make([]byte, 8)
	rand.Read(b)
	return hex.EncodeToString(b)
}

// detach keeps an operation running after its caller stops waiting.
func detach(ctx context.Context) (context.Context, context.CancelFunc) {
	return context.WithTimeout(context.WithoutCancel(ctx), operationTimeout)
}

// cappedReader reads from r and fails with fault.Conflict once more than limit bytes have been read.
type cappedReader struct {
	r           io.Reader
	limit, read int64
}

func (c *cappedReader) Read(p []byte) (int, error) {
	n, err := c.r.Read(p)
	c.read += int64(n)
	if c.read > c.limit {
		return n, fmt.Errorf("%w: program history is larger than %d bytes", fault.Conflict, c.limit)
	}
	return n, err
}
