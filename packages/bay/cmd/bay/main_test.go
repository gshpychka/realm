package main

import (
	"bytes"
	"errors"
	"fmt"
	"path/filepath"
	"regexp"
	"slices"
	"strings"
	"testing"

	"github.com/gshpychka/realm/packages/bay/internal/fault"
)

func TestHelp(t *testing.T) {
	h := newHarness(t)
	names := []string{
		"start", "attach", "list", "show", "suspend", "resume", "snap", "end", "rm", "threads", "read", "send", "help",
	}
	for _, args := range [][]string{{"help"}, {"-h"}, {"--help"}, {"help", "help"}, {"help", "-h"}, {"help", "--help"}} {
		t.Run(strings.Join(args, " "), func(t *testing.T) {
			got := h.run("", args...)
			if got.code != 0 || got.stderr != "" {
				t.Fatalf("exit %d, stderr %q", got.code, got.stderr)
			}
			for _, name := range names {
				if !regexp.MustCompile("(?m)^  " + name + "( |$)").MatchString(got.stdout) {
					t.Errorf("usage does not list %s:\n%s", name, got.stdout)
				}
			}
			if !strings.Contains(got.stdout, "$BAY_SOCKET") {
				t.Errorf("usage does not name the socket variable:\n%s", got.stdout)
			}
		})
	}
}

func TestNoCommand(t *testing.T) {
	h := newHarness(t)
	got := h.run("")
	if got.code != 2 || got.stdout != "" || !strings.HasPrefix(got.stderr, "usage: bay COMMAND") {
		t.Errorf("got exit %d, stdout %q, stderr %q", got.code, got.stdout, got.stderr)
	}
}

func TestUnknownCommand(t *testing.T) {
	h := newHarness(t)
	got := h.run("", "frobnicate")
	if got.code != 2 || got.stdout != "" || !strings.Contains(got.stderr, `unknown command "frobnicate"`) {
		t.Errorf("got exit %d, stdout %q, stderr %q", got.code, got.stdout, got.stderr)
	}
}

func TestCommandHelp(t *testing.T) {
	h := newHarness(t)
	tests := []struct {
		args []string
		want string
	}{
		{[]string{"rm", "-h"}, "usage: bay rm NAME [--yes]\n"},
		{[]string{"start", "foo", "--help"},
			"usage: bay start NAME [PROGRAM] [--repo OWNER/NAME[@REF]]... [-- COMMAND...]\n"},
		{[]string{"list", "-h"}, "usage: bay list [--json]\n"},
		{[]string{"help", "list"}, "usage: bay list [--json]\n"},
		{[]string{"help", "read"}, "usage: bay read THREAD [--json]\n"},
	}
	for _, tt := range tests {
		t.Run(tt.args[0], func(t *testing.T) {
			got := h.run("", tt.args...)
			if got.code != 0 || got.stderr != "" || !strings.HasPrefix(got.stdout, tt.want) {
				t.Errorf("got exit %d, stdout %q, stderr %q", got.code, got.stdout, got.stderr)
			}
		})
	}
	if len(h.svc.calls) != 0 {
		t.Errorf("help reached the server: %q", h.svc.calls)
	}
}

func TestUsageErrors(t *testing.T) {
	tests := []struct {
		name  string
		stdin string
		args  []string
		want  string
	}{
		{"start without a name", "", []string{"start"}, "missing argument"},
		{"start with three names", "", []string{"start", "a", "b", "c"}, `unexpected argument "c"`},
		{"start with a program and a command", "", []string{"start", "a", "claude", "--", "sh"}, "give a program or a command"},
		{"start with an empty command", "", []string{"start", "a", "--", ""}, "the command is empty"},
		{"start with an unknown flag", "", []string{"start", "foo", "--bogus"}, "flag provided but not defined: -bogus"},
		{"start repo without a value", "", []string{"start", "foo", "--repo"}, "flag needs an argument: -repo"},
		{"start with a malformed repo", "", []string{"start", "foo", "--repo", "nope"},
			`invalid value "nope" for flag -repo: want OWNER/NAME or OWNER/NAME@REF`},
		{"start with an empty repo revision", "", []string{"start", "foo", "--repo", "acme/bay@"}, "want OWNER/NAME or OWNER/NAME@REF"},
		{"attach without a name", "", []string{"attach"}, "missing argument"},
		{"list with an argument", "", []string{"list", "extra"}, `unexpected argument "extra"`},
		{"show without a name", "", []string{"show"}, "missing argument"},
		{"suspend with two names", "", []string{"suspend", "a", "b"}, `unexpected argument "b"`},
		{"resume snapshot without a value", "", []string{"resume", "foo", "--snapshot"}, "flag needs an argument: -snapshot"},
		{"snap with three names", "", []string{"snap", "a", "b", "c"}, `unexpected argument "c"`},
		{"end with an unknown flag", "", []string{"end", "foo", "-f"}, "flag provided but not defined: -f"},
		{"rm without a name", "", []string{"rm"}, "missing argument"},
		{"threads with an argument", "", []string{"threads", "extra"}, `unexpected argument "extra"`},
		{"read without a thread", "", []string{"read"}, "missing argument"},
		{"read a thread that is not a number", "", []string{"read", "abc"}, `invalid thread "abc"`},
		{"read a negative thread", "", []string{"read", "-1"}, "flag provided but not defined"},
		{"send without a recipient", "", []string{"send"}, "missing argument"},
		{"send to a thread that is not a number", "", []string{"send", "--thread", "x", "alice", "hi"}, "invalid value"},
		{"send nothing", "", []string{"send", "alice"}, "empty message"},
		{"send an empty argument", "", []string{"send", "alice", ""}, "empty message"},
		{"send blank stdin", " \n\n", []string{"send", "alice", "-"}, "empty message"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			h := newHarness(t)
			got := h.run(tt.stdin, tt.args...)
			if got.code != 2 || got.stdout != "" {
				t.Errorf("got exit %d, stdout %q, stderr %q", got.code, got.stdout, got.stderr)
			}
			if !strings.Contains(got.stderr, tt.want) {
				t.Errorf("stderr %q does not contain %q", got.stderr, tt.want)
			}
			if !strings.Contains(got.stderr, "usage: bay "+tt.args[0]) {
				t.Errorf("stderr %q does not show the usage of %s", got.stderr, tt.args[0])
			}
			if calls := slices.Concat(h.svc.calls, h.msgs.calls); len(calls) != 0 {
				t.Errorf("the server was called: %q", calls)
			}
		})
	}
}

func TestServerFailures(t *testing.T) {
	tests := [][]string{
		{"start", "foo"},
		{"list"},
		{"show", "foo"},
		{"suspend", "foo"},
		{"resume", "foo"},
		{"snap", "foo"},
		{"end", "foo", "--yes"},
		{"rm", "foo", "--yes"},
		{"threads"},
		{"read", "7"},
		{"send", "foo", "hi"},
	}
	for _, args := range tests {
		t.Run(args[0], func(t *testing.T) {
			h := newHarness(t)
			failure := fmt.Errorf("%w: session foo is busy", fault.Conflict)
			h.svc.err, h.msgs.err = failure, failure
			got := h.run("", args...)
			if got.code != 1 || got.stdout != "" || !strings.HasSuffix(got.stderr, "bay: conflict: session foo is busy\n") {
				t.Errorf("got exit %d, stdout %q, stderr %q", got.code, got.stdout, got.stderr)
			}
		})
	}
}

func TestServerFailureCannotDriveTheTerminal(t *testing.T) {
	h := newHarness(t)
	h.svc.err = errors.New("exit status 1: \x1b]52;c;aGVsbG8=\x07\x1b[2Jstopped")
	got := h.run("", "suspend", "foo")
	if got.code != 1 || got.stderr != "bay: exit status 1: �]52;c;aGVsbG8=��[2Jstopped\n" {
		t.Errorf("got exit %d, stderr %q", got.code, got.stderr)
	}
}

func TestMissingSession(t *testing.T) {
	h := newHarness(t)
	got := h.run("", "show", "nosuch")
	if got.code != 1 || got.stdout != "" || got.stderr != "bay: not found: no session named nosuch\n" {
		t.Errorf("got exit %d, stdout %q, stderr %q", got.code, got.stdout, got.stderr)
	}
}

func TestUnreachableServer(t *testing.T) {
	socket := filepath.Join(t.TempDir(), "missing.sock")
	t.Setenv("BAY_SOCKET", socket)
	var stdout, stderr bytes.Buffer
	code := run([]string{"list"}, strings.NewReader(""), &stdout, &stderr)
	if code != 1 || stdout.Len() != 0 {
		t.Errorf("got exit %d, stdout %q", code, stdout.String())
	}
	if !strings.Contains(stderr.String(), socket) {
		t.Errorf("stderr %q does not name the socket %s", stderr.String(), socket)
	}
	if strings.Contains(stderr.String(), "http://") {
		t.Errorf("stderr %q shows the request URL", stderr.String())
	}
}

func TestSocketPath(t *testing.T) {
	t.Setenv("BAY_SOCKET", "")
	if got := socketPath(); got != "/run/bay/bay.sock" {
		t.Errorf("default socket is %q", got)
	}
	t.Setenv("BAY_SOCKET", "/tmp/other.sock")
	if got := socketPath(); got != "/tmp/other.sock" {
		t.Errorf("socket is %q", got)
	}
}
