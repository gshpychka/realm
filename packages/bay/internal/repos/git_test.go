package repos

import (
	"context"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/gshpychka/realm/packages/bay/internal/sessions"
)

func TestGitEnvironment(t *testing.T) {
	requireGit(t)
	ambient := t.TempDir()
	if err := os.WriteFile(filepath.Join(ambient, ".gitconfig"), []byte("[user]\n\tname = leaked\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("HOME", ambient)
	t.Setenv("XDG_CONFIG_HOME", ambient)
	t.Setenv("GIT_NAMESPACE", "ambient")
	t.Setenv("GIT_OBJECT_DIRECTORY", ambient)
	t.Setenv("GIT_TERMINAL_PROMPT", "1")
	home := t.TempDir()
	g, err := newGit(home)
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()

	// a shell alias reports the environment git hands its children
	out, err := g.run(ctx, "", "-c", "alias.env=!env", "env")
	if err != nil {
		t.Fatal(err)
	}
	env := map[string]string{}
	for _, kv := range strings.Split(out, "\n") {
		if k, v, ok := strings.Cut(kv, "="); ok {
			env[k] = v
		}
	}
	for k, want := range map[string]string{
		"HOME":                home,
		"GIT_TERMINAL_PROMPT": "0",
		"GIT_CONFIG_NOSYSTEM": "1",
		"GIT_CONFIG_GLOBAL":   os.DevNull,
	} {
		if env[k] != want {
			t.Errorf("git runs with %s=%q, want %q", k, env[k], want)
		}
	}
	if !strings.HasSuffix(env["PATH"], os.Getenv("PATH")) {
		t.Errorf("git runs with PATH=%q, which does not end in the inherited PATH", env["PATH"])
	}
	for _, k := range []string{"GIT_NAMESPACE", "GIT_OBJECT_DIRECTORY"} {
		if v, ok := env[k]; ok {
			t.Errorf("git runs with the inherited %s=%q", k, v)
		}
	}

	if out, err := g.run(ctx, "", "config", "--global", "--get", "user.name"); err == nil {
		t.Errorf("git read the user's config: user.name = %q", out)
	}
	out, err = g.run(ctx, "", "config", "--get", "gc.autoDetach")
	if err != nil || strings.TrimSpace(out) != "false" {
		t.Errorf("gc.autoDetach = %q, %v; want false", out, err)
	}
}

func TestMirrorsPresentNoCredentials(t *testing.T) {
	requireGit(t)
	askpass := filepath.Join(t.TempDir(), "askpass")
	if err := os.WriteFile(askpass, []byte("#!/bin/sh\necho supplied\n"), 0o700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("SSH_ASKPASS", askpass)
	var presented atomic.Bool
	remote := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "" {
			presented.Store(true)
		}
		w.Header().Set("WWW-Authenticate", `Basic realm="bay"`)
		w.WriteHeader(http.StatusUnauthorized)
	}))
	defer remote.Close()
	m, err := New(t.TempDir(), remote.URL+"/")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := m.Resolve(context.Background(), sessions.RepoRef{Owner: "o", Name: "n"}); err == nil {
		t.Fatal("Resolve succeeded against a remote that demands credentials")
	}
	if presented.Load() {
		t.Error("git presented credentials to the remote")
	}
}

func TestMirrorsIgnoreAmbientGit(t *testing.T) {
	f := newFixture(t)
	h := seed(f.upstream("o", "n"))
	gitconfig := filepath.Join(t.TempDir(), "config")
	if err := os.WriteFile(gitconfig, []byte("[url \"file:///nonexistent/\"]\n\tinsteadOf = file://\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("GIT_CONFIG_GLOBAL", gitconfig)
	t.Setenv("GIT_CONFIG_COUNT", "1")
	t.Setenv("GIT_CONFIG_KEY_0", "url.file:///nonexistent/.insteadOf")
	t.Setenv("GIT_CONFIG_VALUE_0", "file://")
	t.Setenv("GIT_NAMESPACE", "ambient")
	t.Setenv("GIT_OBJECT_DIRECTORY", t.TempDir())
	got, err := f.mirrors().Resolve(context.Background(), sessions.RepoRef{Owner: "o", Name: "n"})
	if err != nil {
		t.Fatal(err)
	}
	if got.Commit != h.second {
		t.Fatalf("Resolve returned %+v, want %s", got, h.second)
	}
}
