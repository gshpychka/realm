package main

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"slices"
	"testing"

	"github.com/gshpychka/realm/packages/bay/internal/api"
	"github.com/gshpychka/realm/packages/bay/internal/fault"
)

func TestStart(t *testing.T) {
	tests := []struct {
		name string
		args []string
		want api.Start
	}{
		{"only a name starts the session again", []string{"foo"}, api.Start{}},
		{"program", []string{"foo", "claude"}, api.Start{Program: "claude"}},
		{"command", []string{"foo", "--", "sh", "-c", "echo hi"}, api.Start{Command: []string{"sh", "-c", "echo hi"}}},
		{"repos with a login shell", []string{"foo", "--repo", "acmeco/bay", "--repo", "acmeco/toolbox@main"},
			api.Start{Repos: []string{"acmeco/bay", "acmeco/toolbox@main"}}},
		{"flags before the name", []string{"--repo", "acmeco/bay", "foo", "claude"},
			api.Start{Program: "claude", Repos: []string{"acmeco/bay"}}},
		{"flags between the name and the program", []string{"foo", "--repo", "acmeco/bay", "claude"},
			api.Start{Program: "claude", Repos: []string{"acmeco/bay"}}},
		{"flags after the program", []string{"foo", "claude", "--repo=acmeco/bay@v1"},
			api.Start{Program: "claude", Repos: []string{"acmeco/bay@v1"}}},
		{"flags before the command", []string{"foo", "--repo", "acmeco/bay", "--", "sh"},
			api.Start{Command: []string{"sh"}, Repos: []string{"acmeco/bay"}}},
		{"flags inside the command belong to it", []string{"foo", "--", "sh", "--repo", "x", "-h"},
			api.Start{Command: []string{"sh", "--repo", "x", "-h"}}},
		{"a trailing -- adds no command", []string{"foo", "--"}, api.Start{}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			h := newHarness(t)
			got := h.run("", append([]string{"start"}, tt.args...)...)
			if got.code != 0 {
				t.Fatalf("exit %d, stderr %q", got.code, got.stderr)
			}
			if !slices.Equal(h.svc.calls, []string{"Start foo"}) {
				t.Errorf("calls = %q", h.svc.calls)
			}
			if !reflect.DeepEqual(h.svc.gotStart, tt.want) {
				t.Errorf("start = %+v, want %+v", h.svc.gotStart, tt.want)
			}
		})
	}
}

func TestStartReportsProgressAndState(t *testing.T) {
	h := newHarness(t)
	got := h.run("", "start", "foo", "claude")
	if got.code != 0 || got.stdout != "foo running\n" || got.stderr != "starting foo...\n" {
		t.Errorf("got exit %d, stdout %q, stderr %q", got.code, got.stdout, got.stderr)
	}
}

func TestList(t *testing.T) {
	inZone(t)
	h := newHarness(t)
	h.svc.sessions = []api.Session{
		{
			Name: "alpha", State: api.Running, Program: "claude", Created: utc(10, 5, 19, 30),
			Repos: []api.Repo{
				{Owner: "acmeco", Name: "bay", Branch: "main", Commit: "1a2b3c4d5e6f70819203a4b5c6d7e8f901234567"},
				{Owner: "acmeco", Name: "toolbox", Commit: "9f8e7d6c5b4a3928171605948372615049382716"},
			},
		},
		{Name: "beta", State: api.Ended, Command: []string{"sleep", "100"}, Created: utc(10, 5, 19, 45)},
		{
			Name: "gamma", State: api.Suspended, Created: utc(10, 5, 20, 0),
			Repos: []api.Repo{{Owner: "acmeco", Name: "bay", Commit: "0123456789abcdef0123456789abcdef01234567"}},
		},
	}
	got := h.run("", "list")
	want := `NAME   STATE      PROGRAM        REPOS                                       CREATED
alpha  running    claude         acmeco/bay@1a2b3c4, acmeco/toolbox@9f8e7d6  2026-10-05 22:30
beta   ended      sleep 100      -                                           2026-10-05 22:45
gamma  suspended  (login shell)  acmeco/bay@0123456                          2026-10-05 23:00
`
	if got.code != 0 || got.stdout != want || got.stderr != "" {
		t.Errorf("got exit %d, stderr %q, stdout:\n%s\nwant:\n%s", got.code, got.stderr, got.stdout, want)
	}
}

func TestListWithoutSessions(t *testing.T) {
	h := newHarness(t)
	got := h.run("", "list")
	if got.code != 0 || got.stdout != "NAME  STATE  PROGRAM  REPOS  CREATED\n" || got.stderr != "" {
		t.Errorf("got exit %d, stdout %q, stderr %q", got.code, got.stdout, got.stderr)
	}
}

func TestShow(t *testing.T) {
	inZone(t)
	tests := []struct {
		name    string
		session api.Session
		want    string
	}{
		{
			"running with repos and snapshots",
			api.Session{
				Name: "alpha", State: api.Running, Program: "claude", Created: utc(10, 5, 19, 30),
				Repos: []api.Repo{
					{Owner: "acmeco", Name: "bay", Branch: "main", Commit: "1a2b3c4d5e6f70819203a4b5c6d7e8f901234567"},
					{Owner: "acmeco", Name: "toolbox", Commit: "9f8e7d6c5b4a3928171605948372615049382716"},
				},
				Snapshots: []string{"before-refactor", "20261005-223000"},
			},
			`Name:       alpha
State:      running
Program:    claude
Created:    2026-10-05 22:30
Repos:      acmeco/bay@1a2b3c4d5e6f70819203a4b5c6d7e8f901234567 (main)
            acmeco/toolbox@9f8e7d6c5b4a3928171605948372615049382716
Snapshots:  before-refactor, 20261005-223000
`,
		},
		{
			"ended with a command",
			api.Session{Name: "beta", State: api.Ended, Command: []string{"sleep", "100"}, Created: utc(10, 5, 19, 45)},
			`Name:       beta
State:      ended
Program:    sleep 100
Created:    2026-10-05 22:45
Repos:      -
Snapshots:  -
`,
		},
		{
			"suspended with a login shell",
			api.Session{Name: "gamma", State: api.Suspended, Created: utc(10, 5, 20, 0)},
			`Name:       gamma
State:      suspended
Program:    (login shell)
Created:    2026-10-05 23:00
Repos:      -
Snapshots:  -
`,
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			h := newHarness(t)
			h.svc.sessions = []api.Session{tt.session}
			got := h.run("", "show", tt.session.Name)
			if got.code != 0 || got.stdout != tt.want || got.stderr != "" {
				t.Errorf("got exit %d, stderr %q, stdout:\n%s\nwant:\n%s", got.code, got.stderr, got.stdout, tt.want)
			}
		})
	}
}

func TestSuspend(t *testing.T) {
	h := newHarness(t)
	got := h.run("", "suspend", "foo")
	if got.code != 0 || got.stdout != "foo suspended\n" || got.stderr != "" {
		t.Errorf("got exit %d, stdout %q, stderr %q", got.code, got.stdout, got.stderr)
	}
	if !slices.Equal(h.svc.calls, []string{"Suspend foo"}) {
		t.Errorf("calls = %q", h.svc.calls)
	}
}

func TestResume(t *testing.T) {
	const prompt = "Rolling foo back to a deletes the snapshots after it: b, c. Continue? [y/N] "
	later := []string{"b", "c"}
	tests := []struct {
		name     string
		terminal bool
		stdin    string
		args     []string
		calls    []string
		resumed  api.Resume
		code     int
		stdout   string
		stderr   string
	}{
		{"from suspended memory", false, "", []string{"foo"},
			[]string{"Resume foo"}, api.Resume{}, 0, "foo resumed\n", ""},
		{"back to the newest snapshot", false, "", []string{"foo", "--snapshot", "c"},
			[]string{"Get foo", "Resume foo"}, api.Resume{Snapshot: "c"}, 0, "foo rolled back to c\n", ""},
		{"back to an older snapshot, confirmed", true, "y\n", []string{"foo", "--snapshot", "a"},
			[]string{"Get foo", "Resume foo"}, api.Resume{Snapshot: "a", Discard: later}, 0, "foo rolled back to a\n", prompt},
		{"back to an older snapshot, declined", true, "n\n", []string{"foo", "--snapshot", "a"},
			[]string{"Get foo"}, api.Resume{}, 1, "", prompt + "bay: aborted\n"},
		{"--yes after the name", false, "", []string{"foo", "--snapshot", "a", "--yes"},
			[]string{"Get foo", "Resume foo"}, api.Resume{Snapshot: "a", Discard: later}, 0, "foo rolled back to a\n", ""},
		{"flags before the name", false, "", []string{"--yes", "--snapshot=a", "foo"},
			[]string{"Get foo", "Resume foo"}, api.Resume{Snapshot: "a", Discard: later}, 0, "foo rolled back to a\n", ""},
		{"no terminal", false, "y\n", []string{"foo", "--snapshot", "a"},
			[]string{"Get foo"}, api.Resume{}, 1, "", "bay: Rolling foo back to a deletes the snapshots after it: b, c. Pass --yes to go ahead without a terminal.\n"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			h := newHarness(t)
			h.svc.sessions = []api.Session{{Name: "foo", State: api.Running, Snapshots: []string{"a", "b", "c"}}}
			got := h.runAs(tt.terminal, tt.stdin, append([]string{"resume"}, tt.args...)...)
			if got.code != tt.code || got.stdout != tt.stdout || got.stderr != tt.stderr {
				t.Errorf("got exit %d, stdout %q, stderr %q", got.code, got.stdout, got.stderr)
			}
			if !slices.Equal(h.svc.calls, tt.calls) {
				t.Errorf("calls = %q, want %q", h.svc.calls, tt.calls)
			}
			if !reflect.DeepEqual(h.svc.gotResume, tt.resumed) {
				t.Errorf("resume = %+v, want %+v", h.svc.gotResume, tt.resumed)
			}
		})
	}
}

func TestResumeLeavesUnknownSnapshotsToTheServer(t *testing.T) {
	h := newHarness(t)
	h.svc.sessions = []api.Session{{Name: "foo", State: api.Running, Snapshots: []string{"a"}}}
	h.svc.errs = map[string]error{"Resume": fmt.Errorf("%w: session foo has no snapshot zzz", fault.NotFound)}
	got := h.run("", "resume", "foo", "--snapshot", "zzz")
	if got.code != 1 || got.stdout != "" || got.stderr != "bay: not found: session foo has no snapshot zzz\n" {
		t.Errorf("got exit %d, stdout %q, stderr %q", got.code, got.stdout, got.stderr)
	}
	if !reflect.DeepEqual(h.svc.gotResume, api.Resume{Snapshot: "zzz"}) {
		t.Errorf("resume = %+v", h.svc.gotResume)
	}
}

func TestSnap(t *testing.T) {
	tests := []struct {
		name string
		args []string
		want api.Snap
	}{
		{"named by the server", []string{"foo"}, api.Snap{}},
		{"named by the operator", []string{"foo", "before"}, api.Snap{Snapshot: "before"}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			h := newHarness(t)
			h.svc.snapped = api.Snapped{Snapshot: "20261005-223000"}
			got := h.run("", append([]string{"snap"}, tt.args...)...)
			if got.code != 0 || got.stdout != "20261005-223000\n" || got.stderr != "" {
				t.Errorf("got exit %d, stdout %q, stderr %q", got.code, got.stdout, got.stderr)
			}
			if h.svc.gotSnap != tt.want {
				t.Errorf("snap = %+v, want %+v", h.svc.gotSnap, tt.want)
			}
		})
	}
}

func TestEnd(t *testing.T) {
	const prompt = "Ending foo deletes its snapshots: a, b. Continue? [y/N] "
	snapshots := []string{"a", "b"}
	tests := []struct {
		name      string
		terminal  bool
		stdin     string
		args      []string
		snapshots []string
		ended     bool
		code      int
		stderr    string
	}{
		{"yes", true, "y\n", []string{"foo"}, snapshots, true, 0, prompt},
		{"yes in capitals", true, "YES\n", []string{"foo"}, snapshots, true, 0, prompt},
		{"no", true, "n\n", []string{"foo"}, snapshots, false, 1, prompt + "bay: aborted\n"},
		{"empty answer", true, "\n", []string{"foo"}, snapshots, false, 1, prompt + "bay: aborted\n"},
		{"end of input", true, "", []string{"foo"}, snapshots, false, 1, prompt + "bay: aborted\n"},
		{"another word", true, "yep\n", []string{"foo"}, snapshots, false, 1, prompt + "bay: aborted\n"},
		{"--yes after the name", false, "", []string{"foo", "--yes"}, snapshots, true, 0, ""},
		{"--yes before the name", false, "", []string{"--yes", "foo"}, snapshots, true, 0, ""},
		{"--yes on a terminal", true, "n\n", []string{"foo", "--yes"}, snapshots, true, 0, ""},
		{"no terminal", false, "y\n", []string{"foo"}, snapshots, false, 1,
			"bay: Ending foo deletes its snapshots: a, b. Pass --yes to go ahead without a terminal.\n"},
		{"no snapshots to confirm", false, "", []string{"foo"}, nil, true, 0, ""},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			h := newHarness(t)
			h.svc.sessions = []api.Session{{Name: "foo", State: api.Running, Snapshots: tt.snapshots}}
			got := h.runAs(tt.terminal, tt.stdin, append([]string{"end"}, tt.args...)...)
			wantOut := ""
			wantCalls := []string{"Get foo"}
			if tt.ended {
				wantOut = "foo ended\n"
				wantCalls = append(wantCalls, "End foo")
			}
			if got.code != tt.code || got.stdout != wantOut || got.stderr != tt.stderr {
				t.Errorf("got exit %d, stdout %q, stderr %q", got.code, got.stdout, got.stderr)
			}
			if !slices.Equal(h.svc.calls, wantCalls) {
				t.Errorf("calls = %q, want %q", h.svc.calls, wantCalls)
			}
			if tt.ended && !slices.Equal(h.svc.gotEnd.Snapshots, tt.snapshots) {
				t.Errorf("ended with snapshots %q, want exactly %q", h.svc.gotEnd.Snapshots, tt.snapshots)
			}
		})
	}
}

func TestEndRefusedWhenTheSnapshotsChanged(t *testing.T) {
	h := newHarness(t)
	h.svc.sessions = []api.Session{{Name: "foo", State: api.Running, Snapshots: []string{"a"}}}
	refusal := fmt.Errorf("%w: session foo has snapshots a, b, and ending deletes them", fault.Conflict)
	h.svc.errs = map[string]error{"End": refusal}
	got := h.run("", "end", "foo", "--yes")
	want := "bay: conflict: session foo has snapshots a, b, and ending deletes them\n"
	if got.code != 1 || got.stdout != "" || got.stderr != want {
		t.Errorf("got exit %d, stdout %q, stderr %q", got.code, got.stdout, got.stderr)
	}
	if !slices.Equal(h.svc.gotEnd.Snapshots, []string{"a"}) {
		t.Errorf("ended with snapshots %q, want the ones listed", h.svc.gotEnd.Snapshots)
	}
}

func TestRm(t *testing.T) {
	const prompt = "Removing foo deletes its record and history. Continue? [y/N] "
	tests := []struct {
		name     string
		terminal bool
		stdin    string
		args     []string
		removed  bool
		code     int
		stderr   string
	}{
		{"yes", true, "y\n", []string{"foo"}, true, 0, prompt},
		{"no", true, "no\n", []string{"foo"}, false, 1, prompt + "bay: aborted\n"},
		{"end of input", true, "", []string{"foo"}, false, 1, prompt + "bay: aborted\n"},
		{"--yes after the name", false, "", []string{"foo", "--yes"}, true, 0, ""},
		{"--yes before the name", false, "", []string{"--yes", "foo"}, true, 0, ""},
		{"no terminal", false, "y\n", []string{"foo"}, false, 1,
			"bay: Removing foo deletes its record and history. Pass --yes to go ahead without a terminal.\n"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			h := newHarness(t)
			got := h.runAs(tt.terminal, tt.stdin, append([]string{"rm"}, tt.args...)...)
			wantOut := ""
			var wantCalls []string
			if tt.removed {
				wantOut = "foo removed\n"
				wantCalls = []string{"Remove foo"}
			}
			if got.code != tt.code || got.stdout != wantOut || got.stderr != tt.stderr {
				t.Errorf("got exit %d, stdout %q, stderr %q", got.code, got.stdout, got.stderr)
			}
			if !slices.Equal(h.svc.calls, wantCalls) {
				t.Errorf("calls = %q, want %q", h.svc.calls, wantCalls)
			}
		})
	}
}

// attachCall is what the cli handed to execve.
type attachCall struct {
	path string
	argv []string
	env  []string
}

func TestAttachRunsTheServersCommand(t *testing.T) {
	h := newHarness(t)
	exe, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", filepath.Dir(exe))
	command := []string{filepath.Base(exe), "exec", "foo", "--", "bay-session", "attach"}
	h.svc.attach = api.Attach{Command: command}
	var call *attachCall
	got := h.runWith(func(c *cli) {
		c.execve = func(path string, argv, env []string) error {
			call = &attachCall{path, argv, env}
			return nil
		}
	}, "", "attach", "foo")
	if got.code != 0 || got.stdout != "" || got.stderr != "" {
		t.Fatalf("got exit %d, stdout %q, stderr %q", got.code, got.stdout, got.stderr)
	}
	if call == nil {
		t.Fatal("the process was not replaced")
	}
	if call.path != exe || !slices.Equal(call.argv, command) || !slices.Contains(call.env, "PATH="+filepath.Dir(exe)) {
		t.Errorf("exec %q %q with environment %q", call.path, call.argv, call.env)
	}
}

func TestAttachNeedsATerminal(t *testing.T) {
	h := newHarness(t)
	got := h.run("", "attach", "foo")
	if got.code != 1 || got.stdout != "" || got.stderr != "bay: attach needs a terminal, and stdin is not one\n" {
		t.Errorf("got exit %d, stdout %q, stderr %q", got.code, got.stdout, got.stderr)
	}
	if len(h.svc.calls) != 0 {
		t.Errorf("the server was called: %q", h.svc.calls)
	}
}

func TestAttachFailures(t *testing.T) {
	tests := []struct {
		name   string
		attach api.Attach
		err    error
		want   string
	}{
		{"server refuses", api.Attach{}, fmt.Errorf("%w: session foo is suspended", fault.Conflict),
			"bay: conflict: session foo is suspended\n"},
		{"no command", api.Attach{}, nil, "bay: the server returned no command to attach with\n"},
		{"command not installed", api.Attach{Command: []string{"bay-test-no-such-program"}}, nil,
			"bay: exec: \"bay-test-no-such-program\": executable file not found in $PATH\n"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			h := newHarness(t)
			t.Setenv("PATH", t.TempDir())
			h.svc.attach, h.svc.err = tt.attach, tt.err
			replaced := false
			got := h.runWith(func(c *cli) {
				c.execve = func(string, []string, []string) error {
					replaced = true
					return nil
				}
			}, "", "attach", "foo")
			if got.code != 1 || got.stdout != "" || got.stderr != tt.want {
				t.Errorf("got exit %d, stdout %q, stderr %q, want stderr %q", got.code, got.stdout, got.stderr, tt.want)
			}
			if replaced {
				t.Error("the process was replaced")
			}
		})
	}
}

func TestAttachReportsAFailedExec(t *testing.T) {
	h := newHarness(t)
	exe, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	h.svc.attach = api.Attach{Command: []string{exe}}
	got := h.runWith(func(c *cli) {
		c.execve = func(string, []string, []string) error { return errors.New("exec format error") }
	}, "", "attach", "foo")
	want := fmt.Sprintf("bay: run %s: exec format error\n", exe)
	if got.code != 1 || got.stdout != "" || got.stderr != want {
		t.Errorf("got exit %d, stdout %q, stderr %q, want stderr %q", got.code, got.stdout, got.stderr, want)
	}
}
