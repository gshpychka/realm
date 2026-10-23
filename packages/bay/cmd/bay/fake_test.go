package main

import (
	"bytes"
	"context"
	"fmt"
	"net"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/gshpychka/realm/packages/bay/internal/api"
	"github.com/gshpychka/realm/packages/bay/internal/fault"
	"github.com/gshpychka/realm/packages/bay/internal/messages"
)

// fakeService is an api.Service that answers from fixed data and records the calls it receives.
type fakeService struct {
	mu sync.Mutex
	// err fails every call, except the methods that errs names.
	err      error
	errs     map[string]error
	sessions []api.Session
	attach   api.Attach
	snapped  api.Snapped

	calls     []string
	gotStart  api.Start
	gotResume api.Resume
	gotSnap   api.Snap
	gotEnd    api.End
}

// enter records call and holds the lock until the returned function runs.
func (f *fakeService) enter(call string) func() {
	f.mu.Lock()
	f.calls = append(f.calls, call)
	return f.mu.Unlock
}

func (f *fakeService) failure(method string) error {
	if err, ok := f.errs[method]; ok {
		return err
	}
	return f.err
}

func (f *fakeService) List(context.Context) ([]api.Session, error) {
	defer f.enter("List")()
	return f.sessions, f.failure("List")
}

func (f *fakeService) Get(_ context.Context, name string) (api.Session, error) {
	defer f.enter("Get " + name)()
	if err := f.failure("Get"); err != nil {
		return api.Session{}, err
	}
	for _, s := range f.sessions {
		if s.Name == name {
			return s, nil
		}
	}
	return api.Session{}, fmt.Errorf("%w: no session named %s", fault.NotFound, name)
}

func (f *fakeService) Start(_ context.Context, name string, s api.Start) (api.Session, error) {
	defer f.enter("Start " + name)()
	f.gotStart = s
	if err := f.failure("Start"); err != nil {
		return api.Session{}, err
	}
	return api.Session{Name: name, State: api.Running}, nil
}

func (f *fakeService) Suspend(_ context.Context, name string) error {
	defer f.enter("Suspend " + name)()
	return f.failure("Suspend")
}

func (f *fakeService) Resume(_ context.Context, name string, r api.Resume) error {
	defer f.enter("Resume " + name)()
	f.gotResume = r
	return f.failure("Resume")
}

func (f *fakeService) Snap(_ context.Context, name string, s api.Snap) (api.Snapped, error) {
	defer f.enter("Snap " + name)()
	f.gotSnap = s
	return f.snapped, f.failure("Snap")
}

func (f *fakeService) End(_ context.Context, name string, e api.End) error {
	defer f.enter("End " + name)()
	f.gotEnd = e
	return f.failure("End")
}

func (f *fakeService) Remove(_ context.Context, name string) error {
	defer f.enter("Remove " + name)()
	return f.failure("Remove")
}

func (f *fakeService) Attach(_ context.Context, name string) (api.Attach, error) {
	defer f.enter("Attach " + name)()
	return f.attach, f.failure("Attach")
}

// fakeMessages is a messages.Service that answers from fixed data and records the calls it receives.
type fakeMessages struct {
	mu           sync.Mutex
	err          error
	threads      []messages.Thread
	conversation messages.Conversation

	calls  []string
	sent   []messages.Send
	before int64
}

// newThread is the thread that a message starting one lands in.
const newThread = 42

func (f *fakeMessages) enter(call string) func() {
	f.mu.Lock()
	f.calls = append(f.calls, call)
	return f.mu.Unlock
}

func (f *fakeMessages) Threads(context.Context) ([]messages.Thread, error) {
	defer f.enter("Threads")()
	return f.threads, f.err
}

func (f *fakeMessages) Conversation(_ context.Context, thread, before int64) (messages.Conversation, error) {
	defer f.enter(fmt.Sprintf("Conversation %d", thread))()
	f.before = before
	return f.conversation, f.err
}

func (f *fakeMessages) Send(_ context.Context, s messages.Send) (messages.Message, error) {
	defer f.enter("Send")()
	f.sent = append(f.sent, s)
	if f.err != nil {
		return messages.Message{}, f.err
	}
	thread := s.Thread
	if thread == 0 {
		thread = newThread
	}
	return messages.Message{ID: 1, Thread: thread, From: messages.Operator, To: s.To, Body: s.Body}, nil
}

// harness is the Bay server API on the unix socket that BAY_SOCKET names, backed by fakes.
type harness struct {
	svc  *fakeService
	msgs *fakeMessages
}

func newHarness(t *testing.T) *harness {
	t.Helper()
	h := &harness{svc: &fakeService{}, msgs: &fakeMessages{}}
	socket := filepath.Join(t.TempDir(), "bay.sock")
	l, err := net.Listen("unix", socket)
	if err != nil {
		t.Fatal(err)
	}
	server := &httptest.Server{
		Listener: l,
		Config:   &http.Server{Handler: api.Handler(h.svc, messages.Handler(h.msgs))},
	}
	server.Start()
	t.Cleanup(server.Close)
	t.Setenv("BAY_SOCKET", socket)
	return h
}

type result struct {
	code           int
	stdout, stderr string
}

// run runs bay with a stdin that is not a terminal.
func (h *harness) run(stdin string, args ...string) result {
	var stdout, stderr bytes.Buffer
	code := run(args, strings.NewReader(stdin), &stdout, &stderr)
	return result{code, stdout.String(), stderr.String()}
}

// runAs runs bay on a terminal, or not, where the operator types stdin.
func (h *harness) runAs(terminal bool, stdin string, args ...string) result {
	if terminal {
		return h.runWith(func(*cli) {}, stdin, args...)
	}
	return h.run(stdin, args...)
}

// runWith runs bay in a terminal after adjust has changed the cli.
func (h *harness) runWith(adjust func(*cli), stdin string, args ...string) result {
	var stdout, stderr bytes.Buffer
	c := newCLI(strings.NewReader(stdin), &stdout, &stderr)
	c.terminal = true
	adjust(c)
	code := c.run(args)
	return result{code, stdout.String(), stderr.String()}
}

// inZone makes local time UTC+3 for the rest of the test.
func inZone(t *testing.T) {
	t.Helper()
	saved := time.Local
	time.Local = time.FixedZone("UTC+3", 3*60*60)
	t.Cleanup(func() { time.Local = saved })
}

func utc(month time.Month, day, hour, minute int) time.Time {
	return time.Date(2026, month, day, hour, minute, 0, 0, time.UTC)
}
