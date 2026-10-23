package sessions

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/gshpychka/realm/packages/bay/internal/fault"
	"github.com/gshpychka/realm/packages/bay/internal/machines"
	"github.com/gshpychka/realm/packages/bay/internal/records"
)

// fakeInstances keeps instances in memory and plays the guest's bay-session command.
type fakeInstances struct {
	mu        sync.Mutex
	instances map[string]*fakeInstance
	// failOn makes the guest operation with this name fail.
	failOn string
	// coldStart makes Start report that no memory was restored.
	coldStart bool
	// block, when set, holds Start until it is closed.
	block chan struct{}
	// gates holds the operations named "<instance> <guest operation>" or "<instance> restore" until released.
	gates map[string]*gate
	// deleteFails makes Delete fail.
	deleteFails bool
	// snapshotCalls counts Snapshot calls.
	snapshotCalls int
}

// gate holds an operation until release is closed and signals when the operation arrives.
type gate struct {
	once    sync.Once
	arrived chan struct{}
	release chan struct{}
}

func (g *gate) wait() {
	g.once.Do(func() { close(g.arrived) })
	<-g.release
}

// hold makes the named operation of an instance wait at its gate.
func (f *fakeInstances) hold(name, op string) *gate {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.gates == nil {
		f.gates = map[string]*gate{}
	}
	g := &gate{arrived: make(chan struct{}), release: make(chan struct{})}
	f.gates[name+" "+op] = g
	return g
}

// lose ends the program of a running instance, as a cold boot does.
func (f *fakeInstances) lose(name string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.instances[name].program = false
}

type fakeInstance struct {
	sessionID string
	running   bool
	saved     bool
	// program is whether the guest's tmux server holds the program.
	program   bool
	snapshots []string
	cid       uint32
	// guest records every bay-session invocation; history is what restore-history received.
	guest   [][]string
	history string
	files   string
	machine *machines.Selection
}

func newFakeInstances() *fakeInstances {
	return &fakeInstances{instances: map[string]*fakeInstance{}}
}

func (f *fakeInstances) get(name string) (*fakeInstance, error) {
	inst, ok := f.instances[name]
	if !ok {
		return nil, fmt.Errorf("%w: no instance %s", fault.NotFound, name)
	}
	return inst, nil
}

func (f *fakeInstances) Create(_ context.Context, name, sessionID string, machine *machines.Selection) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if _, ok := f.instances[name]; ok {
		return fmt.Errorf("instance %s exists", name)
	}
	f.instances[name] = &fakeInstance{sessionID: sessionID, cid: uint32(100 + len(f.instances)), machine: machine}
	return nil
}

func (f *fakeInstances) Start(_ context.Context, name string) (bool, error) {
	if f.block != nil {
		<-f.block
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	inst, err := f.get(name)
	if err != nil {
		return false, err
	}
	restored := inst.saved && !f.coldStart
	inst.running, inst.saved = true, false
	if !restored {
		inst.program = false
	}
	return restored, nil
}

func (f *fakeInstances) Suspend(_ context.Context, name string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	inst, err := f.get(name)
	if err != nil {
		return err
	}
	inst.running, inst.saved = false, true
	return nil
}

func (f *fakeInstances) Delete(_ context.Context, name string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.deleteFails {
		return errors.New("delete failed")
	}
	delete(f.instances, name)
	return nil
}

func (f *fakeInstances) Status(_ context.Context, name string) (Status, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.status(name), nil
}

func (f *fakeInstances) status(name string) Status {
	inst, ok := f.instances[name]
	switch {
	case !ok:
		return InstanceAbsent
	case inst.running:
		return InstanceRunning
	default:
		return InstanceStopped
	}
}

func (f *fakeInstances) Statuses(context.Context) (map[string]Status, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	out := map[string]Status{}
	for name := range f.instances {
		out[name] = f.status(name)
	}
	return out, nil
}

func (f *fakeInstances) Snapshot(_ context.Context, name, snapshot string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	inst, err := f.get(name)
	if err != nil {
		return err
	}
	f.snapshotCalls++
	inst.snapshots = append(inst.snapshots, snapshot)
	return nil
}

func (f *fakeInstances) Snapshots(_ context.Context, name string) ([]string, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	inst, err := f.get(name)
	if err != nil {
		return nil, err
	}
	return slices.Clone(inst.snapshots), nil
}

func (f *fakeInstances) Restore(_ context.Context, name, snapshot string) error {
	f.mu.Lock()
	inst, err := f.get(name)
	if err != nil {
		f.mu.Unlock()
		return err
	}
	if !slices.Contains(inst.snapshots, snapshot) {
		f.mu.Unlock()
		return fmt.Errorf("%w: no snapshot %s", fault.NotFound, snapshot)
	}
	// an instance reports stopped while it restores
	inst.running = false
	g := f.gates[name+" restore"]
	f.mu.Unlock()
	if g != nil {
		g.wait()
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	inst.running, inst.saved, inst.program = true, false, true
	return nil
}

func (f *fakeInstances) Exec(_ context.Context, name string, argv []string, stdin io.Reader, stdout io.Writer) error {
	f.mu.Lock()
	inst, err := f.get(name)
	if err != nil {
		f.mu.Unlock()
		return err
	}
	if !inst.running {
		f.mu.Unlock()
		return errors.New("instance is not running")
	}
	inst.guest = append(inst.guest, argv)
	files := inst.files
	var g *gate
	if len(argv) > 1 {
		g = f.gates[name+" "+argv[1]]
	}
	f.mu.Unlock()
	if len(argv) < 2 || argv[0] != "bay-session" {
		return fmt.Errorf("unexpected guest command %q", argv)
	}
	if g != nil {
		g.wait()
	}
	if argv[1] == f.failOn {
		return fmt.Errorf("%s failed", argv[1])
	}
	switch argv[1] {
	case "launch":
		f.mu.Lock()
		inst.program = true
		f.mu.Unlock()
	case "stop":
		f.mu.Lock()
		inst.program = false
		f.mu.Unlock()
	case "program":
		f.mu.Lock()
		running := inst.program
		f.mu.Unlock()
		if running {
			_, err := io.WriteString(stdout, "running\n")
			return err
		}
		_, err := io.WriteString(stdout, "stopped\n")
		return err
	case "save-history":
		_, err := io.WriteString(stdout, files)
		return err
	case "restore-history":
		data, err := io.ReadAll(stdin)
		f.mu.Lock()
		inst.history = string(data)
		inst.files = string(data)
		f.mu.Unlock()
		return err
	case "deliver-repo":
		_, err := io.Copy(io.Discard, stdin)
		return err
	}
	return nil
}

func (f *fakeInstances) Caller(_ context.Context, cid uint32) (string, string, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	for name, inst := range f.instances {
		if inst.cid == cid && inst.running {
			return name, inst.sessionID, nil
		}
	}
	return "", "", fmt.Errorf("%w: cid %d", fault.NotFound, cid)
}

func (f *fakeInstances) AttachCommand(name string, argv []string) []string {
	return append([]string{"attach", name}, argv...)
}

func (f *fakeInstances) guestOps(name string) []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	var ops []string
	for _, argv := range f.instances[name].guest {
		ops = append(ops, argv[1])
	}
	return ops
}

func (f *fakeInstances) lastLaunch(name string) []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	var launch []string
	for _, argv := range f.instances[name].guest {
		if argv[1] == "launch" {
			launch = argv[2:]
		}
	}
	return launch
}

type fakeRepos struct{}

func (fakeRepos) Resolve(_ context.Context, ref RepoRef) (records.Repo, error) {
	if ref.Ref == "missing" {
		return records.Repo{}, fmt.Errorf("%w: no ref %s", fault.Invalid, ref.Ref)
	}
	return records.Repo{Owner: ref.Owner, Name: ref.Name, Branch: "main", Commit: "c0ffee"}, nil
}

func (fakeRepos) Archive(_ context.Context, r records.Repo, w io.Writer) error {
	_, err := io.WriteString(w, "archive of "+r.Name)
	return err
}

func (fakeRepos) Remote(r records.Repo) string {
	return "https://example.com/" + r.Owner + "/" + r.Name + ".git"
}

func newService(t *testing.T, maxRunning int) (*Service, *fakeInstances, *records.Store) {
	t.Helper()
	return newServiceOver(t, maxRunning, fakeRepos{})
}

func newServiceOver(t *testing.T, maxRunning int, repos Repos) (*Service, *fakeInstances, *records.Store) {
	t.Helper()
	store, err := records.Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	instances := newFakeInstances()
	svc, err := New(store, instances, repos, Config{
		Programs: map[string]Program{
			"agent": {Command: []string{"agent"}, Resume: []string{"agent", "--continue"}, History: []string{".agent"}},
			"tool":  {Command: []string{"tool"}, Monitor: true},
		},
		MaxRunning: maxRunning,
		MaxMemory:  maxRunning,
		Machines:   map[string]machines.Definition{machines.Default: machineDefinition("a", 1)},
		Reserved:   []string{"base", "operator"},
	}, slog.New(slog.NewTextHandler(io.Discard, nil)))
	if err != nil {
		t.Fatal(err)
	}
	return svc, instances, store
}

func mustStart(t *testing.T, svc *Service, name string, spec StartSpec) Session {
	t.Helper()
	s, err := svc.Start(context.Background(), name, spec)
	if err != nil {
		t.Fatalf("Start(%s): %v", name, err)
	}
	return s
}

func wantKind(t *testing.T, err, kind error) {
	t.Helper()
	if !errors.Is(err, kind) {
		t.Fatalf("got error %v, want %v", err, kind)
	}
}

func TestStartNew(t *testing.T) {
	svc, instances, store := newService(t, 4)
	s := mustStart(t, svc, "one", StartSpec{Program: "agent", Repos: []RepoRef{{Owner: "o", Name: "r"}}})
	if s.State != Running || s.Program.Definition != "agent" || s.Repos[0].Commit != "c0ffee" {
		t.Fatalf("Start returned %+v", s)
	}
	if got := instances.guestOps("one"); !slices.Equal(got, []string{"ready", "deliver-repo", "launch"}) {
		t.Fatalf("guest operations %v", got)
	}
	if got := instances.lastLaunch("one"); !slices.Equal(got, []string{"quiet", "--", "agent"}) {
		t.Fatalf("launch %v", got)
	}
	rec, err := store.Get("one")
	if err != nil || rec.ID == "" || instances.instances["one"].sessionID != rec.ID {
		t.Fatalf("record %+v, instance session %q, err %v", rec, instances.instances["one"].sessionID, err)
	}
}

func TestStartNewWithoutSpecRunsALoginShell(t *testing.T) {
	svc, instances, _ := newService(t, 4)
	s := mustStart(t, svc, "shell", StartSpec{})
	if s.State != Running || s.Program.Definition != "" || len(s.Program.Command) != 0 {
		t.Fatalf("Start returned %+v", s)
	}
	if got := instances.lastLaunch("shell"); !slices.Equal(got, []string{"monitor", "--"}) {
		t.Fatalf("launch %v", got)
	}
}

func TestStartMonitorsProgramsWithoutHooks(t *testing.T) {
	svc, instances, _ := newService(t, 4)
	mustStart(t, svc, "one", StartSpec{Program: "tool"})
	if got := instances.lastLaunch("one"); !slices.Equal(got, []string{"monitor", "--", "tool"}) {
		t.Fatalf("launch %v", got)
	}
	mustStart(t, svc, "two", StartSpec{Command: []string{"htop", "-d", "5"}})
	if got := instances.lastLaunch("two"); !slices.Equal(got, []string{"monitor", "--", "htop", "-d", "5"}) {
		t.Fatalf("launch %v", got)
	}
	mustStart(t, svc, "three", StartSpec{Program: "agent"})
	if got := instances.lastLaunch("three"); !slices.Equal(got, []string{"quiet", "--", "agent"}) {
		t.Fatalf("a program whose definition sets no monitoring launched %v", got)
	}
}

func TestStartRejects(t *testing.T) {
	svc, _, _ := newService(t, 4)
	mustStart(t, svc, "one", StartSpec{})
	tests := []struct {
		name string
		spec StartSpec
		kind error
	}{
		{"one", StartSpec{}, fault.Conflict},
		{"Bad", StartSpec{}, fault.Invalid},
		{"-x", StartSpec{}, fault.Invalid},
		{".x", StartSpec{}, fault.Invalid},
		{"a/b", StartSpec{}, fault.Invalid},
		{"two/", StartSpec{}, fault.Invalid},
		{"base", StartSpec{}, fault.Invalid},
		{"operator", StartSpec{}, fault.Invalid},
		{"x", StartSpec{Program: "nope"}, fault.Invalid},
		{"x", StartSpec{Program: "agent", Command: []string{"a"}}, fault.Invalid},
		{"x", StartSpec{Command: []string{""}}, fault.Invalid},
		{"x", StartSpec{Command: []string{"sh", "\x00"}}, fault.Invalid},
		{"x", StartSpec{Repos: []RepoRef{{Owner: "o", Name: "r", Ref: "missing"}}}, fault.Invalid},
		{"x", StartSpec{Repos: []RepoRef{{Owner: "o", Name: "r"}, {Owner: "o", Name: "r", Ref: "dev"}}}, fault.Invalid},
		{"one", StartSpec{}, fault.Conflict},
	}
	for _, tt := range tests {
		_, err := svc.Start(context.Background(), tt.name, tt.spec)
		if !errors.Is(err, tt.kind) {
			t.Errorf("Start(%q, %+v) = %v, want %v", tt.name, tt.spec, err, tt.kind)
		}
	}
}

func TestStartRollsBack(t *testing.T) {
	svc, instances, store := newService(t, 4)
	instances.failOn = "launch"
	if _, err := svc.Start(context.Background(), "one", StartSpec{}); err == nil {
		t.Fatal("Start succeeded with a failing launch")
	}
	if _, ok := instances.instances["one"]; ok {
		t.Fatal("instance survived the failed start")
	}
	if _, err := store.Get("one"); !errors.Is(err, records.ErrNotFound) {
		t.Fatalf("record survived the failed start: %v", err)
	}

	instances.failOn = ""
	mustStart(t, svc, "two", StartSpec{Program: "agent"})
	instances.instances["two"].files = "transcript"
	if err := svc.End(context.Background(), "two", nil); err != nil {
		t.Fatal(err)
	}
	instances.failOn = "restore-history"
	if _, err := svc.Start(context.Background(), "two", StartSpec{}); err == nil {
		t.Fatal("Start from record succeeded with a failing restore")
	}
	if _, err := store.Get("two"); err != nil {
		t.Fatalf("a failed start again removed the record: %v", err)
	}
	if _, ok := instances.instances["two"]; ok {
		t.Fatal("instance survived the failed start again")
	}
}

func TestEndAndStartAgainCarriesHistory(t *testing.T) {
	svc, instances, store := newService(t, 4)
	mustStart(t, svc, "one", StartSpec{Program: "agent"})
	instances.instances["one"].files = "transcript"
	if err := svc.End(context.Background(), "one", nil); err != nil {
		t.Fatal(err)
	}
	if s, _ := svc.Get(context.Background(), "one"); s.State != Ended {
		t.Fatalf("state after End: %s", s.State)
	}
	r, err := store.History("one")
	if err != nil {
		t.Fatal(err)
	}
	saved, _ := io.ReadAll(r)
	r.Close()
	if string(saved) != "transcript" {
		t.Fatalf("saved history %q", saved)
	}
	mustStart(t, svc, "one", StartSpec{})
	if instances.instances["one"].history != "transcript" {
		t.Fatalf("restored history %q", instances.instances["one"].history)
	}
	if got := instances.lastLaunch("one"); !slices.Equal(got, []string{"quiet", "--", "agent", "--continue"}) {
		t.Fatalf("launch %v, want the resume command", got)
	}
}

func TestStartAgainWithoutHistoryLaunchesFresh(t *testing.T) {
	svc, instances, _ := newService(t, 4)
	mustStart(t, svc, "one", StartSpec{Command: []string{"htop"}})
	if err := svc.End(context.Background(), "one", nil); err != nil {
		t.Fatal(err)
	}
	mustStart(t, svc, "one", StartSpec{})
	if got := instances.lastLaunch("one"); !slices.Equal(got, []string{"monitor", "--", "htop"}) {
		t.Fatalf("launch %v", got)
	}
	if slices.Contains(instances.guestOps("one"), "restore-history") {
		t.Fatal("a program without history had history restored")
	}
}

func TestEndRequiresAcknowledgedSnapshots(t *testing.T) {
	svc, instances, _ := newService(t, 4)
	mustStart(t, svc, "one", StartSpec{})
	if _, err := svc.Snap(context.Background(), "one", "a"); err != nil {
		t.Fatal(err)
	}
	wantKind(t, svc.End(context.Background(), "one", nil), fault.Conflict)
	wantKind(t, svc.End(context.Background(), "one", []string{"a", "b"}), fault.Conflict)
	if err := svc.End(context.Background(), "one", []string{"a"}); err != nil {
		t.Fatal(err)
	}
	if _, ok := instances.instances["one"]; ok {
		t.Fatal("instance survived End")
	}
	wantKind(t, svc.End(context.Background(), "one", nil), fault.Conflict)
}

func TestEndSuspendedSession(t *testing.T) {
	svc, instances, store := newService(t, 4)
	mustStart(t, svc, "agent", StartSpec{Program: "agent"})
	mustStart(t, svc, "plain", StartSpec{})
	for _, name := range []string{"agent", "plain"} {
		if err := svc.Suspend(context.Background(), name); err != nil {
			t.Fatal(err)
		}
	}
	instances.instances["agent"].files = "transcript"
	if err := svc.End(context.Background(), "agent", nil); err != nil {
		t.Fatal(err)
	}
	if _, err := store.History("agent"); err != nil {
		t.Fatalf("history of a suspended session: %v", err)
	}
	if err := svc.End(context.Background(), "plain", nil); err != nil {
		t.Fatalf("ending a suspended session without history: %v", err)
	}
	if _, err := store.History("plain"); !errors.Is(err, records.ErrNotFound) {
		t.Fatalf("a program without history saved some: %v", err)
	}
}

func TestSuspendResume(t *testing.T) {
	svc, instances, _ := newService(t, 4)
	mustStart(t, svc, "one", StartSpec{Program: "agent"})
	wantKind(t, svc.Resume(context.Background(), "one", "", nil), fault.Conflict)
	if err := svc.Suspend(context.Background(), "one"); err != nil {
		t.Fatal(err)
	}
	if s, _ := svc.Get(context.Background(), "one"); s.State != Suspended {
		t.Fatalf("state %s", s.State)
	}
	wantKind(t, svc.Suspend(context.Background(), "one"), fault.Conflict)
	launches := len(instances.instances["one"].guest)
	if err := svc.Resume(context.Background(), "one", "", nil); err != nil {
		t.Fatal(err)
	}
	if len(instances.instances["one"].guest) != launches {
		t.Fatal("resuming saved memory ran guest commands")
	}

	if err := svc.Suspend(context.Background(), "one"); err != nil {
		t.Fatal(err)
	}
	instances.coldStart = true
	if err := svc.Resume(context.Background(), "one", "", nil); err != nil {
		t.Fatal(err)
	}
	if got := instances.lastLaunch("one"); !slices.Equal(got, []string{"quiet", "--", "agent", "--continue"}) {
		t.Fatalf("a cold resume launched %v, want the resume command", got)
	}
}

func TestSnapAndRollBack(t *testing.T) {
	svc, _, _ := newService(t, 4)
	mustStart(t, svc, "one", StartSpec{})
	name, err := svc.Snap(context.Background(), "one", "")
	if err != nil || name == "" {
		t.Fatalf("Snap = %q, %v", name, err)
	}
	_, err = svc.Snap(context.Background(), "one", "bad/name")
	wantKind(t, err, fault.Invalid)
	if err := svc.Resume(context.Background(), "one", name, nil); err != nil {
		t.Fatal(err)
	}
	if err := svc.Suspend(context.Background(), "one"); err != nil {
		t.Fatal(err)
	}
	_, err = svc.Snap(context.Background(), "one", "x")
	wantKind(t, err, fault.Conflict)
	if err := svc.Resume(context.Background(), "one", name, nil); err != nil {
		t.Fatalf("rolling a suspended session back: %v", err)
	}
	if s, _ := svc.Get(context.Background(), "one"); s.State != Running || !slices.Equal(s.Snapshots, []string{name}) {
		t.Fatalf("after roll back: %+v", s)
	}
}

func TestRollBackPastLaterSnapshots(t *testing.T) {
	svc, _, _ := newService(t, 4)
	mustStart(t, svc, "one", StartSpec{})
	for _, name := range []string{"a", "b", "c"} {
		if _, err := svc.Snap(context.Background(), "one", name); err != nil {
			t.Fatal(err)
		}
	}
	wantKind(t, svc.Resume(context.Background(), "one", "a", nil), fault.Conflict)
	wantKind(t, svc.Resume(context.Background(), "one", "a", []string{"b"}), fault.Conflict)
	wantKind(t, svc.Resume(context.Background(), "one", "z", nil), fault.NotFound)
	if err := svc.Resume(context.Background(), "one", "c", nil); err != nil {
		t.Fatalf("rolling back to the latest snapshot: %v", err)
	}
	if err := svc.Resume(context.Background(), "one", "a", []string{"c", "b"}); err != nil {
		t.Fatal(err)
	}
}

func TestCapacity(t *testing.T) {
	svc, _, _ := newService(t, 2)
	mustStart(t, svc, "one", StartSpec{})
	mustStart(t, svc, "two", StartSpec{})
	_, err := svc.Start(context.Background(), "three", StartSpec{})
	wantKind(t, err, fault.Conflict)
	if err := svc.Suspend(context.Background(), "one"); err != nil {
		t.Fatal(err)
	}
	mustStart(t, svc, "three", StartSpec{})
	wantKind(t, svc.Resume(context.Background(), "one", "", nil), fault.Conflict)
}

func TestBusySession(t *testing.T) {
	svc, instances, _ := newService(t, 4)
	instances.block = make(chan struct{})
	done := make(chan error)
	go func() {
		_, err := svc.Start(context.Background(), "one", StartSpec{})
		done <- err
	}()
	for {
		svc.mu.Lock()
		busy := svc.busy["one"]
		svc.mu.Unlock()
		if busy {
			break
		}
	}
	wantKind(t, svc.Suspend(context.Background(), "one"), fault.Conflict)
	close(instances.block)
	if err := <-done; err != nil {
		t.Fatal(err)
	}
}

func TestRemove(t *testing.T) {
	svc, instances, store := newService(t, 4)
	mustStart(t, svc, "one", StartSpec{Program: "agent"})
	if err := svc.Remove(context.Background(), "one"); err != nil {
		t.Fatal(err)
	}
	if _, ok := instances.instances["one"]; ok {
		t.Fatal("instance survived Remove")
	}
	if _, err := store.Get("one"); !errors.Is(err, records.ErrNotFound) {
		t.Fatalf("record survived Remove: %v", err)
	}
	wantKind(t, svc.Remove(context.Background(), "one"), fault.NotFound)
}

func TestIdentity(t *testing.T) {
	svc, instances, store := newService(t, 4)
	mustStart(t, svc, "one", StartSpec{})
	rec, _ := store.Get("one")
	cid := instances.instances["one"].cid
	got, err := svc.Caller(context.Background(), cid)
	if err != nil || got.ID != rec.ID || got.Name != "one" {
		t.Fatalf("Caller = %+v, %v", got, err)
	}
	if err := svc.Suspend(context.Background(), "one"); err != nil {
		t.Fatal(err)
	}
	_, err = svc.Caller(context.Background(), cid)
	wantKind(t, err, fault.NotFound)
	if got, err := svc.Lookup("one"); err != nil || got.ID != rec.ID || got.Name != "one" {
		t.Fatalf("Lookup = %+v, %v", got, err)
	}

	// an instance left from an earlier session with the same name is nobody
	if err := svc.Resume(context.Background(), "one", "", nil); err != nil {
		t.Fatal(err)
	}
	instances.instances["one"].sessionID = "earlier"
	_, err = svc.Caller(context.Background(), cid)
	wantKind(t, err, fault.NotFound)
}

func TestListAndAttach(t *testing.T) {
	svc, _, _ := newService(t, 4)
	mustStart(t, svc, "one", StartSpec{})
	mustStart(t, svc, "two", StartSpec{Program: "agent"})
	if err := svc.End(context.Background(), "two", nil); err != nil {
		t.Fatal(err)
	}
	all, err := svc.List(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	var states []string
	for _, s := range all {
		states = append(states, s.Name+"="+string(s.State))
	}
	if strings.Join(states, " ") != "one=running two=ended" {
		t.Fatalf("List states %v", states)
	}
	command, err := svc.AttachCommand(context.Background(), "one")
	if err != nil || strings.Join(command, " ") != "attach one bay-session attach" {
		t.Fatalf("AttachCommand = %v, %v", command, err)
	}
	_, err = svc.AttachCommand(context.Background(), "two")
	wantKind(t, err, fault.Conflict)
}

func TestEndWithoutHistoryFilesStartsFresh(t *testing.T) {
	svc, instances, store := newService(t, 4)
	ctx := context.Background()
	mustStart(t, svc, "one", StartSpec{Program: "agent"})
	if err := svc.End(ctx, "one", nil); err != nil {
		t.Fatal(err)
	}
	if _, err := store.History("one"); !errors.Is(err, records.ErrNotFound) {
		t.Fatalf("a program without history files saved some: %v", err)
	}
	mustStart(t, svc, "one", StartSpec{})
	if got := instances.lastLaunch("one"); !slices.Equal(got, []string{"quiet", "--", "agent"}) {
		t.Fatalf("launch %v, want the program's command", got)
	}
	if slices.Contains(instances.guestOps("one"), "restore-history") {
		t.Fatal("history was restored for a session that saved none")
	}

	instances.instances["one"].files = "transcript"
	if err := svc.End(ctx, "one", nil); err != nil {
		t.Fatal(err)
	}
	mustStart(t, svc, "one", StartSpec{})
	if got := instances.lastLaunch("one"); !slices.Equal(got, []string{"quiet", "--", "agent", "--continue"}) {
		t.Fatalf("launch %v, want the resume command", got)
	}

	// a save after the program deleted its history removes the saved one
	instances.instances["one"].files = ""
	if err := svc.End(ctx, "one", nil); err != nil {
		t.Fatal(err)
	}
	if _, err := store.History("one"); !errors.Is(err, records.ErrNotFound) {
		t.Fatalf("history survived the program deleting it: %v", err)
	}
	mustStart(t, svc, "one", StartSpec{})
	if got := instances.lastLaunch("one"); !slices.Equal(got, []string{"quiet", "--", "agent"}) {
		t.Fatalf("launch %v, want the program's command", got)
	}
}

func TestEndRefusesHistoryOverTheLimit(t *testing.T) {
	svc, instances, store := newService(t, 4)
	svc.maxHistory = 4
	ctx := context.Background()
	mustStart(t, svc, "one", StartSpec{Program: "agent"})
	instances.instances["one"].files = "1234"
	if err := svc.End(ctx, "one", nil); err != nil {
		t.Fatalf("ending with history at the limit: %v", err)
	}
	mustStart(t, svc, "one", StartSpec{})
	instances.instances["one"].files = "12345"
	wantKind(t, svc.End(ctx, "one", nil), fault.Conflict)
	if _, ok := instances.instances["one"]; !ok {
		t.Fatal("End deleted the instance after refusing its history")
	}
	r, err := store.History("one")
	if err != nil {
		t.Fatal(err)
	}
	defer r.Close()
	if saved, _ := io.ReadAll(r); string(saved) != "1234" {
		t.Fatalf("saved history %q, want the previous one", saved)
	}
}

func TestResumeRelaunchesAProgramThatStopped(t *testing.T) {
	svc, instances, _ := newService(t, 2)
	ctx := context.Background()
	mustStart(t, svc, "agent", StartSpec{Program: "agent"})
	mustStart(t, svc, "plain", StartSpec{Command: []string{"htop"}})
	wantKind(t, svc.Resume(ctx, "agent", "", nil), fault.Conflict)
	wantKind(t, svc.Resume(ctx, "plain", "", nil), fault.Conflict)

	instances.lose("agent")
	instances.lose("plain")
	if err := svc.Resume(ctx, "agent", "", nil); err != nil {
		t.Fatal(err)
	}
	if got := instances.lastLaunch("agent"); !slices.Equal(got, []string{"quiet", "--", "agent", "--continue"}) {
		t.Fatalf("a program with history launched %v, want its resume command", got)
	}
	if err := svc.Resume(ctx, "plain", "", nil); err != nil {
		t.Fatal(err)
	}
	if got := instances.lastLaunch("plain"); !slices.Equal(got, []string{"monitor", "--", "htop"}) {
		t.Fatalf("a program without history launched %v, want its command", got)
	}
	wantKind(t, svc.Resume(ctx, "agent", "", nil), fault.Conflict)
	want := []string{"ready", "launch", "ready", "program", "ready", "program", "launch", "ready", "program"}
	if got := instances.guestOps("agent"); !slices.Equal(got, want) {
		t.Fatalf("guest operations %v, want %v", got, want)
	}
}

func TestResumeRelaunchTakesNoRunningSlot(t *testing.T) {
	svc, instances, _ := newService(t, 1)
	mustStart(t, svc, "one", StartSpec{})
	instances.lose("one")
	if err := svc.Resume(context.Background(), "one", "", nil); err != nil {
		t.Fatalf("relaunching a running session at a full cap: %v", err)
	}
}

func TestResumeReportsAFailingProgramCheck(t *testing.T) {
	svc, instances, _ := newService(t, 4)
	mustStart(t, svc, "one", StartSpec{})
	instances.failOn = "program"
	err := svc.Resume(context.Background(), "one", "", nil)
	if err == nil || errors.Is(err, fault.Conflict) {
		t.Fatalf("Resume with a failing program check returned %v", err)
	}
}

func TestCapacityCountsASessionOnce(t *testing.T) {
	svc, instances, _ := newService(t, 3)
	ctx := context.Background()
	mustStart(t, svc, "one", StartSpec{})
	// two's instance runs while its start holds a slot
	g := instances.hold("two", "ready")
	done := make(chan error, 1)
	go func() {
		_, err := svc.Start(ctx, "two", StartSpec{})
		done <- err
	}()
	<-g.arrived
	mustStart(t, svc, "three", StartSpec{})
	_, err := svc.Start(ctx, "four", StartSpec{})
	wantKind(t, err, fault.Conflict)
	close(g.release)
	if err := <-done; err != nil {
		t.Fatal(err)
	}
}

func TestCapacityHoldsUnderConcurrentStarts(t *testing.T) {
	svc, instances, _ := newService(t, 3)
	errs := make([]error, 12)
	var wg sync.WaitGroup
	for i := range errs {
		wg.Go(func() { _, errs[i] = svc.Start(context.Background(), fmt.Sprintf("s%d", i), StartSpec{}) })
	}
	wg.Wait()
	started := 0
	for _, err := range errs {
		switch {
		case err == nil:
			started++
		case !errors.Is(err, fault.Conflict):
			t.Errorf("a concurrent start failed with %v, want success or a conflict", err)
		}
	}
	if running := countRunning(instances); started != 3 || running != 3 {
		t.Fatalf("%d starts succeeded and %d instances run, want 3 of each", started, running)
	}
}

func countRunning(f *fakeInstances) int {
	f.mu.Lock()
	defer f.mu.Unlock()
	n := 0
	for name := range f.instances {
		if f.status(name) == InstanceRunning {
			n++
		}
	}
	return n
}

func TestCapacityHoldsASlotForARollback(t *testing.T) {
	svc, instances, _ := newService(t, 2)
	ctx := context.Background()
	mustStart(t, svc, "a", StartSpec{})
	mustStart(t, svc, "b", StartSpec{})
	if _, err := svc.Snap(ctx, "a", "s"); err != nil {
		t.Fatal(err)
	}
	if err := svc.Suspend(ctx, "b"); err != nil {
		t.Fatal(err)
	}
	mustStart(t, svc, "c", StartSpec{})
	if err := svc.Resume(ctx, "a", "s", nil); err != nil {
		t.Fatalf("rolling a running session back at a full cap: %v", err)
	}

	// a's instance reports stopped while it restores, and a keeps its slot
	g := instances.hold("a", "restore")
	done := make(chan error, 1)
	go func() { done <- svc.Resume(ctx, "a", "s", nil) }()
	<-g.arrived
	wantKind(t, svc.Resume(ctx, "b", "", nil), fault.Conflict)
	close(g.release)
	if err := <-done; err != nil {
		t.Fatal(err)
	}
}

func TestStartOfARunningSessionAtFullCapacity(t *testing.T) {
	svc, _, _ := newService(t, 1)
	mustStart(t, svc, "one", StartSpec{})
	_, err := svc.Start(context.Background(), "one", StartSpec{})
	if err == nil || !strings.Contains(err.Error(), "has not ended") {
		t.Fatalf("Start of a running session returned %v, want the session has not ended", err)
	}
}

// countingRepos counts the repos it resolves.
type countingRepos struct {
	fakeRepos
	resolved int
}

func (c *countingRepos) Resolve(ctx context.Context, ref RepoRef) (records.Repo, error) {
	c.resolved++
	return c.fakeRepos.Resolve(ctx, ref)
}

func TestStartRejectsRepeatedReposBeforeResolvingAny(t *testing.T) {
	repos := &countingRepos{}
	svc, _, _ := newServiceOver(t, 4, repos)
	spec := StartSpec{Repos: []RepoRef{{Owner: "o", Name: "a"}, {Owner: "o", Name: "r"}, {Owner: "o", Name: "r", Ref: "dev"}}}
	_, err := svc.Start(context.Background(), "x", spec)
	wantKind(t, err, fault.Invalid)
	if repos.resolved != 0 {
		t.Fatalf("%d repos were resolved for a start that repeats one", repos.resolved)
	}
	mustStart(t, svc, "y", StartSpec{Repos: []RepoRef{{Owner: "o", Name: "r"}, {Owner: "p", Name: "r"}, {Owner: "o", Name: "s"}}})
}

func TestStartRollbackKeepsTheRecordOfAnInstanceItCannotDelete(t *testing.T) {
	svc, instances, store := newService(t, 4)
	ctx := context.Background()
	instances.failOn = "launch"
	instances.deleteFails = true
	if _, err := svc.Start(ctx, "one", StartSpec{}); err == nil {
		t.Fatal("Start succeeded with a failing launch")
	}
	if _, err := store.Get("one"); err != nil {
		t.Fatalf("the record of an instance that stayed is gone: %v", err)
	}
	if s, err := svc.Get(ctx, "one"); err != nil || s.State != Running {
		t.Fatalf("Get = %+v, %v; want the leftover running session", s, err)
	}

	instances.deleteFails = false
	if err := svc.Remove(ctx, "one"); err != nil {
		t.Fatal(err)
	}
	if _, ok := instances.instances["one"]; ok {
		t.Fatal("instance survived Remove")
	}
	if _, err := store.Get("one"); !errors.Is(err, records.ErrNotFound) {
		t.Fatalf("record survived Remove: %v", err)
	}
}

func TestNamesThatAreNotSessionNamesAreNotFound(t *testing.T) {
	svc, _, _ := newService(t, 4)
	ctx := context.Background()
	for _, name := range []string{"", ".x", "a/b", "two/", "Two", "x y", "a\x00b", strings.Repeat("a", 300)} {
		if _, err := svc.Lookup(name); !errors.Is(err, fault.NotFound) {
			t.Errorf("Lookup(%q) = %v, want fault.NotFound", name, err)
		}
		if _, err := svc.Get(ctx, name); !errors.Is(err, fault.NotFound) {
			t.Errorf("Get(%q) = %v, want fault.NotFound", name, err)
		}
		if err := svc.Remove(ctx, name); !errors.Is(err, fault.NotFound) {
			t.Errorf("Remove(%q) = %v, want fault.NotFound", name, err)
		}
	}
}

func TestSnapNames(t *testing.T) {
	svc, instances, _ := newService(t, 4)
	ctx := context.Background()
	mustStart(t, svc, "one", StartSpec{})
	for _, name := range []string{"pre-", "pre.", "pre_", "-x", ".x", "a b", "a/b", strings.Repeat("a", 64)} {
		_, err := svc.Snap(ctx, "one", name)
		if !errors.Is(err, fault.Invalid) {
			t.Errorf("Snap(%q) = %v, want fault.Invalid", name, err)
		}
	}
	for _, name := range []string{"a", "a.b_c-d", "2026", strings.Repeat("a", 63)} {
		if got, err := svc.Snap(ctx, "one", name); err != nil || got != name {
			t.Errorf("Snap(%q) = %q, %v", name, got, err)
		}
	}
	calls := instances.snapshotCalls
	_, err := svc.Snap(ctx, "one", "a")
	wantKind(t, err, fault.Conflict)
	if instances.snapshotCalls != calls {
		t.Fatal("a snapshot name already in use reached the instance")
	}
}

func TestNewRejectsAConfigNoSessionCanRunUnder(t *testing.T) {
	store, err := records.Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	programs := func(history ...string) map[string]Program {
		return map[string]Program{"p": {Command: []string{"p"}, History: history}}
	}
	for _, config := range []Config{
		{MaxRunning: 0},
		{MaxRunning: -1},
		{MaxRunning: 1, Programs: map[string]Program{"p": {}}},
		{MaxRunning: 1, Programs: map[string]Program{"p": {Command: []string{""}}}},
		{MaxRunning: 1, Programs: map[string]Program{"p": {Command: []string{"p", "\x00"}}}},
		{MaxRunning: 1, Programs: map[string]Program{"p": {Command: []string{"p"}, Resume: []string{""}}}},
		{MaxRunning: 1, Programs: map[string]Program{"": {Command: []string{"p"}}}},
		{MaxRunning: 1, Programs: programs("a\x00b")},
		{MaxRunning: 1, Programs: programs("")},
		{MaxRunning: 1, Programs: programs(".")},
		{MaxRunning: 1, Programs: programs("..")},
		{MaxRunning: 1, Programs: programs("/etc/passwd")},
		{MaxRunning: 1, Programs: programs("../x")},
		{MaxRunning: 1, Programs: programs("a/../b")},
		{MaxRunning: 1, Programs: programs("a/./b")},
		{MaxRunning: 1, Programs: programs("a//b")},
		{MaxRunning: 1, Programs: programs("a/")},
		{MaxRunning: 1, Programs: programs(".ok", "../bad")},
	} {
		if config.MaxRunning > 0 {
			config.MaxMemory = 8
			config.Machines = map[string]machines.Definition{machines.Default: machineDefinition("a", 1)}
		}
		if svc, err := New(store, newFakeInstances(), fakeRepos{}, config, log); err == nil || svc != nil {
			t.Errorf("New(%+v) = %v, %v; want an error", config, svc, err)
		}
	}
	for _, config := range []Config{
		{MaxRunning: 1},
		{MaxRunning: 8, Programs: programs()},
		{MaxRunning: 1, Programs: programs(".claude/projects", ".counter/log", "a", "..a", "a..b")},
	} {
		config.MaxMemory = 8
		config.Machines = map[string]machines.Definition{machines.Default: machineDefinition("a", 1)}
		if _, err := New(store, newFakeInstances(), fakeRepos{}, config, log); err != nil {
			t.Errorf("New(%+v) = %v", config, err)
		}
	}
}

func TestAutomaticSnapshotsAvoidNameCollisions(t *testing.T) {
	svc, instances, _ := newService(t, 4)
	mustStart(t, svc, "one", StartSpec{})
	// Fill nearby timestamps so the test is stable even across a second boundary.
	now := time.Now().UTC()
	for offset := -1; offset <= 60; offset++ {
		name := now.Add(time.Duration(offset) * time.Second).Format("20060102-150405")
		instances.instances["one"].snapshots = append(instances.instances["one"].snapshots, name, name+"-2")
	}
	first, err := svc.Snap(context.Background(), "one", "")
	if err != nil || !strings.HasSuffix(first, "-3") {
		t.Fatalf("automatic snapshot = %q, %v; want an unused name ending -3", first, err)
	}
	second, err := svc.Snap(context.Background(), "one", "")
	if err != nil || second == first {
		t.Fatalf("second automatic snapshot = %q, %v; first was %q", second, err, first)
	}
}

func (f *fakeInstances) Connect(ctx context.Context, name, sessionID string, argv []string, stdin io.Reader, stdout io.Writer) error {
	if err := f.Exec(ctx, name, argv, nil, io.Discard); err != nil {
		return err
	}
	stopped := make(chan struct{})
	defer close(stopped)
	go func() {
		select {
		case <-ctx.Done():
			if r, ok := stdin.(io.Closer); ok {
				r.Close()
			}
		case <-stopped:
		}
	}()
	_, err := io.Copy(stdout, stdin)
	return err
}
