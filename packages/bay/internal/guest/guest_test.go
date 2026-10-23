package guest

import (
	"context"
	"errors"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
	"testing"
)

// recorder is an Exec that records its invocations, answers with stdout and fails with err.
type recorder struct {
	argv   [][]string
	stdin  string
	stdout string
	err    error
}

func (r *recorder) exec(_ context.Context, argv []string, stdin io.Reader, stdout io.Writer) error {
	r.argv = append(r.argv, argv)
	if stdin != nil {
		data, _ := io.ReadAll(stdin)
		r.stdin = string(data)
	}
	io.WriteString(stdout, r.stdout)
	return r.err
}

func TestOperationsRunBaySession(t *testing.T) {
	ctx := context.Background()
	tests := []struct {
		name string
		call func(Guest) error
		want []string
	}{
		{"ready", func(g Guest) error { return g.Ready(ctx) }, []string{"bay-session", "ready"}},
		{"launch quiet", func(g Guest) error { return g.Launch(ctx, []string{"agent", "-x"}, false) }, []string{"bay-session", "launch", "quiet", "--", "agent", "-x"}},
		{"launch monitor", func(g Guest) error { return g.Launch(ctx, []string{"agent"}, true) }, []string{"bay-session", "launch", "monitor", "--", "agent"}},
		{"launch a login shell", func(g Guest) error { return g.Launch(ctx, nil, true) }, []string{"bay-session", "launch", "monitor", "--"}},
		{"stop", func(g Guest) error { return g.Stop(ctx) }, []string{"bay-session", "stop"}},
		{"snapshot ready", func(g Guest) error { return g.SnapshotReady(ctx) }, []string{"bay-session", "snapshot-ready"}},
		{"save history", func(g Guest) error { return g.SaveHistory(ctx, []string{".a", "b/c"}, io.Discard) }, []string{"bay-session", "save-history", "--", ".a", "b/c"}},
		{"restore history", func(g Guest) error { return g.RestoreHistory(ctx, strings.NewReader("")) }, []string{"bay-session", "restore-history"}},
		{
			"deliver a repo",
			func(g Guest) error {
				return g.DeliverRepo(ctx, Checkout{Owner: "o", Name: "r", Branch: "main", Commit: "abc", Remote: "https://example.com/o/r.git"}, strings.NewReader(""))
			},
			[]string{"bay-session", "deliver-repo", "o/r", "abc", "https://example.com/o/r.git", "main"},
		},
		{
			"deliver a repo on a detached head",
			func(g Guest) error {
				return g.DeliverRepo(ctx, Checkout{Owner: "o", Name: "r", Commit: "abc", Remote: "https://example.com/o/r.git"}, strings.NewReader(""))
			},
			[]string{"bay-session", "deliver-repo", "o/r", "abc", "https://example.com/o/r.git", ""},
		},
	}
	for _, tt := range tests {
		r := &recorder{}
		if err := tt.call(New(r.exec)); err != nil {
			t.Errorf("%s: %v", tt.name, err)
			continue
		}
		if len(r.argv) != 1 || !slices.Equal(r.argv[0], tt.want) {
			t.Errorf("%s ran %q, want %q", tt.name, r.argv, tt.want)
		}
	}
}

func TestSnapshotReadinessRequiresAnIdleJobServiceSet(t *testing.T) {
	bash, err := exec.LookPath("bash")
	if err != nil {
		t.Skip(err)
	}
	root := t.TempDir()
	systemctl := "#!" + bash + "\n[ \"$*\" = \"list-units --plain --no-legend --state=activating,active,deactivating bay-job-*\" ] || exit 99\nprintf '%s' \"$BAY_TEST_JOBS\"\nexit \"$BAY_TEST_STATUS\"\n"
	if err := os.WriteFile(filepath.Join(root, "systemctl"), []byte(systemctl), 0700); err != nil {
		t.Fatal(err)
	}
	for _, test := range []struct {
		name, jobs, status string
		success            bool
	}{
		{"idle", "", "0", true},
		{"active job", "bay-job-one.service loaded active running detached job", "0", false},
		{"unavailable service manager", "", "1", false},
	} {
		t.Run(test.name, func(t *testing.T) {
			command := exec.Command(bash, "-e", "../../bay-session.sh", "snapshot-ready")
			command.Env = append(os.Environ(), "PATH="+root, "BAY_TEST_JOBS="+test.jobs, "BAY_TEST_STATUS="+test.status)
			output, err := command.CombinedOutput()
			if (err == nil) != test.success {
				t.Fatalf("snapshot readiness: %v %s", err, output)
			}
		})
	}
}

func TestAttachCommand(t *testing.T) {
	if got := AttachCommand(); !slices.Equal(got, []string{"bay-session", "attach"}) {
		t.Fatalf("AttachCommand = %q", got)
	}
}

func TestStreams(t *testing.T) {
	ctx := context.Background()
	r := &recorder{stdout: "archive"}
	var out strings.Builder
	if err := New(r.exec).SaveHistory(ctx, []string{".a"}, &out); err != nil || out.String() != "archive" {
		t.Fatalf("SaveHistory wrote %q, %v", out.String(), err)
	}
	r = &recorder{}
	if err := New(r.exec).RestoreHistory(ctx, strings.NewReader("archive")); err != nil || r.stdin != "archive" {
		t.Fatalf("RestoreHistory fed %q, %v", r.stdin, err)
	}
	r = &recorder{}
	if err := New(r.exec).DeliverRepo(ctx, Checkout{Owner: "o", Name: "r"}, strings.NewReader("bare")); err != nil || r.stdin != "bare" {
		t.Fatalf("DeliverRepo fed %q, %v", r.stdin, err)
	}
}

func TestRunning(t *testing.T) {
	ctx := context.Background()
	for stdout, want := range map[string]bool{"running\n": true, "running": true, "stopped\n": false, "stopped": false} {
		r := &recorder{stdout: stdout}
		got, err := New(r.exec).Running(ctx)
		if err != nil || got != want {
			t.Errorf("Running with output %q = %v, %v; want %v", stdout, got, err, want)
		}
		if len(r.argv) != 1 || !slices.Equal(r.argv[0], []string{"bay-session", "program"}) {
			t.Errorf("Running ran %q", r.argv)
		}
	}
	for _, stdout := range []string{"", "\n", "yes\n", "running stopped\n", "Running\n", "running" + strings.Repeat("x", 1<<20)} {
		r := &recorder{stdout: stdout}
		if got, err := New(r.exec).Running(ctx); err == nil || got {
			t.Errorf("Running with output %q = %v, %v; want an error", stdout, got, err)
		} else if !strings.Contains(err.Error(), "bay-session program") {
			t.Errorf("Running with output %q returned %q, want an error naming the operation", stdout, err)
		}
	}
}

func TestFailuresNameTheOperation(t *testing.T) {
	boom := errors.New("boom")
	ctx := context.Background()
	for name, call := range map[string]func(Guest) error{
		"ready":   func(g Guest) error { return g.Ready(ctx) },
		"stop":    func(g Guest) error { return g.Stop(ctx) },
		"program": func(g Guest) error { _, err := g.Running(ctx); return err },
	} {
		r := &recorder{err: boom, stdout: "running\n"}
		err := call(New(r.exec))
		if !errors.Is(err, boom) || !strings.HasPrefix(err.Error(), "bay-session "+name+": ") {
			t.Errorf("%s failed with %v, want its cause under the operation's name", name, err)
		}
	}
}
