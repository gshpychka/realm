package main

import (
	"io"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"
)

func writeConfig(t *testing.T, content string) string {
	t.Helper()
	file := filepath.Join(t.TempDir(), "bay-server.json")
	if err := os.WriteFile(file, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
	return file
}

func TestLoadConfig(t *testing.T) {
	config, err := loadConfig(writeConfig(t, `{
		"incusSocket": "/var/lib/incus/unix.socket",
		"project": "bay",
		"base": "base",
		"records": "/var/lib/bay/sessions",
		"mirrors": "/var/lib/bay/mirrors",
		"mirrorRefresh": "90m",
		"gatewaySocket": "/run/bay-gateway/operator.sock",
		"maxRunning": 8,
		"programs": {
			"claude": {"command": ["claude"], "resume": ["claude", "--continue"], "history": [".claude/projects"], "monitor": false}
		}
	}`))
	if err != nil {
		t.Fatal(err)
	}
	claude := config.Programs["claude"]
	if config.Project != "bay" || config.Base != "base" || config.MaxRunning != 8 || config.MirrorRefresh.Duration != 90*time.Minute ||
		!slices.Equal(claude.Command, []string{"claude"}) || !slices.Equal(claude.Resume, []string{"claude", "--continue"}) ||
		!slices.Equal(claude.History, []string{".claude/projects"}) || claude.Monitor {
		t.Fatalf("loadConfig returned %+v", config)
	}
}

func TestLoadConfigRejects(t *testing.T) {
	for name, content := range map[string]string{
		"an unknown key":    `{"project": "bay", "colour": "red"}`,
		"a bad duration":    `{"mirrorRefresh": "soon"}`,
		"a number duration": `{"mirrorRefresh": 5}`,
		"not json":          `project: bay`,
	} {
		file := writeConfig(t, content)
		if _, err := loadConfig(file); err == nil || !strings.Contains(err.Error(), file) {
			t.Errorf("loadConfig with %s returned %v, want an error naming the file", name, err)
		}
	}
	if _, err := loadConfig(filepath.Join(t.TempDir(), "missing.json")); err == nil {
		t.Error("loadConfig of a missing file succeeded")
	}
}

// slowServer serves a request that answers "done" once release is closed, and signals started when it arrives.
func slowServer(t *testing.T, started chan<- struct{}, release <-chan struct{}) (*http.Server, string) {
	t.Helper()
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	server := &http.Server{Handler: http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		close(started)
		<-release
		io.WriteString(w, "done")
	})}
	go server.Serve(l)
	return server, "http://" + l.Addr().String()
}

func TestShutdownWaitsForRequestsInFlight(t *testing.T) {
	started, release := make(chan struct{}), make(chan struct{})
	server, url := slowServer(t, started, release)
	answered := make(chan string, 1)
	go func() {
		resp, err := http.Get(url)
		if err != nil {
			answered <- err.Error()
			return
		}
		defer resp.Body.Close()
		body, _ := io.ReadAll(resp.Body)
		answered <- string(body)
	}()
	<-started

	stopped := make(chan error, 1)
	go func() { stopped <- shutdown([]*http.Server{server}) }()
	select {
	case err := <-stopped:
		t.Fatalf("shutdown returned %v with a request in flight", err)
	case <-time.After(200 * time.Millisecond):
	}

	close(release)
	if err := <-stopped; err != nil {
		t.Fatalf("shutdown returned %v after the request finished", err)
	}
	if got := <-answered; got != "done" {
		t.Fatalf("the request in flight got %q, want its answer", got)
	}
}
