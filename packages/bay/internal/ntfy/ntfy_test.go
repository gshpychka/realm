package ntfy

import (
	"context"
	"errors"
	"io"
	"mime"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
)

// received is what the server saw of one request.
type received struct {
	method string
	path   string
	header http.Header
	body   string
}

// serve starts a server that records each request and answers with status and body.
func serve(t *testing.T, status int, body string) (*httptest.Server, func() received) {
	t.Helper()
	var last atomic.Pointer[received]
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		data, _ := io.ReadAll(r.Body)
		last.Store(&received{method: r.Method, path: r.URL.EscapedPath(), header: r.Header.Clone(), body: string(data)})
		w.WriteHeader(status)
		io.WriteString(w, body)
	}))
	t.Cleanup(srv.Close)
	return srv, func() received {
		got := last.Load()
		if got == nil {
			t.Fatal("the server received no request")
		}
		return *got
	}
}

func TestPublish(t *testing.T) {
	tests := []struct {
		name       string
		token      string
		topic      string
		urlSuffix  string
		n          Notification
		wantPath   string
		wantBody   string
		wantHeader map[string]string
	}{
		{
			name:     "every field",
			token:    "tk_secret",
			topic:    "bay",
			n:        Notification{Title: "alice", Message: "blocked", Tags: []string{"warning", "robot"}, Priority: PriorityHigh},
			wantPath: "/bay",
			wantBody: "blocked",
			wantHeader: map[string]string{
				"Authorization": "Bearer tk_secret",
				"X-Title":       "alice",
				"X-Tags":        "warning,robot",
				"X-Priority":    "4",
			},
		},
		{
			name:     "message only",
			topic:    "bay",
			n:        Notification{Message: "done"},
			wantPath: "/bay",
			wantBody: "done",
			wantHeader: map[string]string{
				"Authorization": "",
				"X-Title":       "",
				"X-Tags":        "",
				"X-Priority":    "",
			},
		},
		{
			name:       "trailing slash in the server URL",
			topic:      "bay",
			urlSuffix:  "/",
			n:          Notification{Message: "done"},
			wantPath:   "/bay",
			wantBody:   "done",
			wantHeader: map[string]string{},
		},
		{
			name:       "topic with a space",
			topic:      "my topic",
			n:          Notification{Message: "done"},
			wantPath:   "/my%20topic",
			wantBody:   "done",
			wantHeader: map[string]string{},
		},
		{
			name:     "the plain header names stay unused",
			topic:    "bay",
			n:        Notification{Title: "t", Message: "m", Tags: []string{"x"}, Priority: PriorityMax},
			wantPath: "/bay",
			wantBody: "m",
			wantHeader: map[string]string{
				"Title":    "",
				"Tags":     "",
				"Priority": "",
			},
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			srv, last := serve(t, http.StatusOK, `{"id":"x"}`)
			c := Client{URL: srv.URL + tt.urlSuffix, Topic: tt.topic, Token: tt.token}
			if err := c.Publish(context.Background(), tt.n); err != nil {
				t.Fatal(err)
			}
			got := last()
			if got.method != http.MethodPost || got.path != tt.wantPath || got.body != tt.wantBody {
				t.Errorf("request was %s %s with body %q, want POST %s with body %q", got.method, got.path, got.body, tt.wantPath, tt.wantBody)
			}
			for name, want := range tt.wantHeader {
				if v := got.header.Values(name); want == "" && len(v) != 0 || want != "" && (len(v) != 1 || v[0] != want) {
					t.Errorf("header %s = %q, want %q", name, v, want)
				}
			}
		})
	}
}

func TestPublishEncodesNonASCIIHeaders(t *testing.T) {
	srv, last := serve(t, http.StatusOK, "{}")
	c := Client{URL: srv.URL, Topic: "bay"}
	if err := c.Publish(context.Background(), Notification{Title: "café ☕", Message: "m", Tags: []string{"naïve"}}); err != nil {
		t.Fatal(err)
	}
	var dec mime.WordDecoder
	for header, want := range map[string]string{"X-Title": "café ☕", "X-Tags": "naïve"} {
		raw := last().header.Get(header)
		if strings.ContainsFunc(raw, func(r rune) bool { return r > 127 }) {
			t.Errorf("%s was sent as raw %q", header, raw)
		}
		if got, err := dec.DecodeHeader(raw); err != nil || got != want {
			t.Errorf("%s decodes to %q (%v), want %q", header, got, err, want)
		}
	}
}

func TestPublishSuccessStatuses(t *testing.T) {
	for _, status := range []int{http.StatusOK, http.StatusAccepted, http.StatusNoContent} {
		srv, _ := serve(t, status, "")
		if err := (&Client{URL: srv.URL, Topic: "bay"}).Publish(context.Background(), Notification{Message: "m"}); err != nil {
			t.Errorf("status %d: %v", status, err)
		}
	}
}

func TestPublishRefusals(t *testing.T) {
	tests := []struct {
		name        string
		status      int
		body        string
		wantMessage string
		wantText    string
	}{
		{"json error", http.StatusForbidden, `{"code":40301,"http":403,"error":"forbidden","link":"https://ntfy.sh/docs"}`, "forbidden", "ntfy: 403 forbidden"},
		{"rate limit", http.StatusTooManyRequests, `{"code":42901,"http":429,"error":"limit reached: too many requests"}`, "limit reached: too many requests", "ntfy: 429 limit reached: too many requests"},
		{"json without an error field", http.StatusBadRequest, `{}`, "Bad Request", "ntfy: 400 Bad Request"},
		{"not json", http.StatusBadGateway, "<html>bad gateway</html>", "Bad Gateway", "ntfy: 502 Bad Gateway"},
		{"empty body", http.StatusInternalServerError, "", "Internal Server Error", "ntfy: 500 Internal Server Error"},
		{"redirect without a location", http.StatusMovedPermanently, "", "Moved Permanently", "ntfy: 301 Moved Permanently"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			srv, _ := serve(t, tt.status, tt.body)
			err := (&Client{URL: srv.URL, Topic: "bay", Token: "tk_secret"}).Publish(context.Background(), Notification{Message: "m"})
			var refused *Error
			if !errors.As(err, &refused) {
				t.Fatalf("Publish returned %v, want an *Error", err)
			}
			if refused.Status != tt.status || refused.Message != tt.wantMessage {
				t.Errorf("Error = %d %q, want %d %q", refused.Status, refused.Message, tt.status, tt.wantMessage)
			}
			if err.Error() != tt.wantText {
				t.Errorf("Error() = %q, want %q", err.Error(), tt.wantText)
			}
			if strings.Contains(err.Error(), "tk_secret") {
				t.Errorf("the error leaks the token: %q", err)
			}
		})
	}
}

func TestPublishUsesTheGivenHTTPClient(t *testing.T) {
	srv, _ := serve(t, http.StatusOK, "{}")
	var calls atomic.Int32
	client := &http.Client{Transport: roundTripper(func(r *http.Request) (*http.Response, error) {
		calls.Add(1)
		return http.DefaultTransport.RoundTrip(r)
	})}
	if err := (&Client{URL: srv.URL, Topic: "bay", HTTP: client}).Publish(context.Background(), Notification{Message: "m"}); err != nil {
		t.Fatal(err)
	}
	if calls.Load() != 1 {
		t.Fatalf("the given client carried %d requests, want 1", calls.Load())
	}
}

type roundTripper func(*http.Request) (*http.Response, error)

func (f roundTripper) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

func TestPublishFailsWhenTheServerIsUnreachable(t *testing.T) {
	srv, _ := serve(t, http.StatusOK, "{}")
	srv.Close()
	err := (&Client{URL: srv.URL, Topic: "bay"}).Publish(context.Background(), Notification{Message: "m"})
	if err == nil {
		t.Fatal("Publish succeeded against a closed server")
	}
	var refused *Error
	if errors.As(err, &refused) {
		t.Fatalf("a transport failure was reported as a refusal: %v", err)
	}
}

func TestPublishHonoursContext(t *testing.T) {
	srv, _ := serve(t, http.StatusOK, "{}")
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if err := (&Client{URL: srv.URL, Topic: "bay"}).Publish(ctx, Notification{Message: "m"}); !errors.Is(err, context.Canceled) {
		t.Fatalf("Publish with a cancelled context returned %v, want context.Canceled", err)
	}
}

func TestPublishRejectsAnInvalidURL(t *testing.T) {
	if err := (&Client{URL: "http://bad host", Topic: "bay"}).Publish(context.Background(), Notification{Message: "m"}); err == nil {
		t.Fatal("Publish accepted an invalid URL")
	}
}
