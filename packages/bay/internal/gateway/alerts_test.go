package gateway_test

import (
	"context"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"

	"github.com/gshpychka/realm/packages/bay/internal/gateway"
	"github.com/gshpychka/realm/packages/bay/internal/ntfy"
	"github.com/gshpychka/realm/packages/bay/internal/sessionapi"
)

func TestNtfyAlerter(t *testing.T) {
	tests := []struct {
		event        string
		wantTags     string
		wantPriority string
	}{
		{string(sessionapi.Done), "white_check_mark", ""},
		{string(sessionapi.Idle), "zzz", ""},
		{string(sessionapi.Blocked), "warning", "4"},
		{gateway.MessageEvent, "envelope", "4"},
		{"something else", "", ""},
	}
	for _, tt := range tests {
		t.Run(tt.event, func(t *testing.T) {
			var seen atomic.Pointer[http.Request]
			var body atomic.Value
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				data, _ := io.ReadAll(r.Body)
				body.Store(string(data))
				seen.Store(r.Clone(context.Background()))
			}))
			t.Cleanup(srv.Close)

			alerter := gateway.NtfyAlerter(&ntfy.Client{URL: srv.URL, Topic: "bay", Token: "tk_test"})
			if err := alerter.Alert(context.Background(), "alice", tt.event); err != nil {
				t.Fatal(err)
			}
			r := seen.Load()
			if r == nil {
				t.Fatal("nothing was published")
			}
			if r.Method != http.MethodPost || r.URL.Path != "/bay" {
				t.Errorf("request = %s %s, want POST /bay", r.Method, r.URL.Path)
			}
			if body.Load() != tt.event {
				t.Errorf("text = %q, want the event %q", body.Load(), tt.event)
			}
			headers := map[string]string{
				"Authorization": "Bearer tk_test",
				"X-Title":       "alice",
				"X-Tags":        tt.wantTags,
				"X-Priority":    tt.wantPriority,
			}
			for name, want := range headers {
				if got := r.Header.Get(name); got != want {
					t.Errorf("header %s = %q, want %q", name, got, want)
				}
			}
			// Nothing but the session and the event leaves the host.
			for name := range r.Header {
				switch name {
				case "Authorization", "X-Title", "X-Tags", "X-Priority", "User-Agent", "Content-Length", "Accept-Encoding":
				default:
					t.Errorf("unexpected header %s", name)
				}
			}
		})
	}
}

func TestNtfyAlerterReportsRefusals(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusForbidden)
		io.WriteString(w, `{"code":40301,"http":403,"error":"forbidden"}`)
	}))
	t.Cleanup(srv.Close)
	err := gateway.NtfyAlerter(&ntfy.Client{URL: srv.URL, Topic: "bay"}).Alert(context.Background(), "alice", "done")
	var refusal *ntfy.Error
	if !errors.As(err, &refusal) || refusal.Status != http.StatusForbidden {
		t.Fatalf("Alert returned %v, want the server's refusal", err)
	}
}
