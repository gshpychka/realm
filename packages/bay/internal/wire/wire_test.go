package wire_test

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gshpychka/realm/packages/bay/internal/fault"
	"github.com/gshpychka/realm/packages/bay/internal/wire"
)

var kinds = []error{fault.NotFound, fault.Conflict, fault.Invalid, fault.Forbidden}

func TestFailGivesEachFaultKindItsStatus(t *testing.T) {
	tests := []struct {
		name   string
		err    error
		status int
	}{
		{"not found", fmt.Errorf("%w: thread 7", fault.NotFound), http.StatusNotFound},
		{"conflict", fmt.Errorf("%w: session is busy", fault.Conflict), http.StatusConflict},
		{"invalid", fmt.Errorf("%w: no body", fault.Invalid), http.StatusBadRequest},
		{"forbidden", fmt.Errorf("%w: unknown caller", fault.Forbidden), http.StatusForbidden},
		{"a kind wrapped by a plain error", fmt.Errorf("send: %w", fmt.Errorf("%w: thread 7", fault.NotFound)), http.StatusNotFound},
		{"an error without a kind", errors.New("write messages.db: input/output error"), http.StatusInternalServerError},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			rec := httptest.NewRecorder()
			wire.Fail(rec, tt.err)
			if rec.Code != tt.status {
				t.Errorf("status = %d, want %d", rec.Code, tt.status)
			}
			if !strings.Contains(rec.Body.String(), tt.err.Error()) {
				t.Errorf("body %q does not carry the error text %q", rec.Body.String(), tt.err)
			}
		})
	}
}

// server answers every request by failing with err.
func server(t *testing.T, err error) wire.Client {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { wire.Fail(w, err) }))
	t.Cleanup(srv.Close)
	return wire.Client{HTTP: srv.Client(), Base: srv.URL}
}

func TestClientReturnsFailuresAsTheirFaultKind(t *testing.T) {
	for _, want := range kinds {
		t.Run(want.Error(), func(t *testing.T) {
			sent := fmt.Errorf("%w: detail", want)
			err := server(t, sent).Do(context.Background(), http.MethodGet, "/", nil, nil)
			if fault.Kind(err) != want {
				t.Fatalf("Do returned %v, want fault kind %v", err, want)
			}
			if err.Error() != sent.Error() {
				t.Errorf("Do returned the text %q, want %q", err, sent)
			}
		})
	}
}

func TestCapacityFailureHasStableCodeAndRetainsConflictCompatibility(t *testing.T) {
	sent := fmt.Errorf("%w: 2 of 2 sessions are running", fault.Capacity)
	response := httptest.NewRecorder()
	wire.Fail(response, sent)
	var body struct {
		Error string `json:"error"`
		Code  string `json:"code"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if response.Code != http.StatusConflict || body.Code != fault.CapacityExhaustedCode || body.Error != "conflict: 2 of 2 sessions are running" {
		t.Fatalf("capacity response: %d %+v", response.Code, body)
	}
	err := server(t, sent).Do(context.Background(), http.MethodPost, "/start", struct{}{}, nil)
	if !errors.Is(err, fault.Capacity) || !errors.Is(err, fault.Conflict) || fault.Kind(err) != fault.Conflict {
		t.Fatalf("capacity identity lost across HTTP: %v", err)
	}
	ordinary := httptest.NewRecorder()
	wire.Fail(ordinary, fmt.Errorf("%w: session already exists", fault.Conflict))
	if strings.Contains(ordinary.Body.String(), `"code"`) {
		t.Fatalf("ordinary conflict received admission semantics: %s", ordinary.Body.String())
	}
}

func TestLaunchRejectionCodePreservesItsOriginalFaultKindAcrossHTTP(t *testing.T) {
	for _, kind := range []error{fault.Invalid, fault.Conflict} {
		t.Run(kind.Error(), func(t *testing.T) {
			sent := fault.WithCode(fmt.Errorf("%w: the frozen launch declaration changed", kind), fault.LaunchRejectedCode)
			err := server(t, sent).Do(context.Background(), http.MethodPost, "/start", struct{}{}, nil)
			if !errors.Is(err, kind) || fault.Code(err) != fault.LaunchRejectedCode || err.Error() != sent.Error() {
				t.Fatalf("launch rejection lost its original semantics: %v, code %q", err, fault.Code(err))
			}
		})
	}
}

func TestClientReturnsOtherFailuresWithoutAKind(t *testing.T) {
	err := server(t, errors.New("disk gone")).Do(context.Background(), http.MethodGet, "/", nil, nil)
	if err == nil || err.Error() != "disk gone" || fault.Kind(err) != nil {
		t.Errorf("Do returned %v (kind %v), want the text of a failure without a kind", err, fault.Kind(err))
	}

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		http.Error(w, "<html>upstream down</html>", http.StatusBadGateway)
	}))
	t.Cleanup(srv.Close)
	err = wire.Client{HTTP: srv.Client(), Base: srv.URL}.Do(context.Background(), http.MethodGet, "/", nil, nil)
	if err == nil || err.Error() != "502 Bad Gateway" || fault.Kind(err) != nil {
		t.Errorf("Do returned %v (kind %v), want the status of a reply that is no failure message", err, fault.Kind(err))
	}
}

func TestReadRejectsUnknownFields(t *testing.T) {
	var in struct{ Name string }
	req := httptest.NewRequest(http.MethodPost, "/", strings.NewReader(`{"name":"a","extra":1}`))
	if err := wire.Read(req, &in); !errors.Is(err, fault.Invalid) {
		t.Errorf("Read returned %v, want fault.Invalid", err)
	}
	req = httptest.NewRequest(http.MethodPost, "/", strings.NewReader(`{"name":"a"}`))
	if err := wire.Read(req, &in); err != nil || in.Name != "a" {
		t.Errorf("Read returned %v with %+v", err, in)
	}
}

func TestReadRequiresOneBoundedJSONObject(t *testing.T) {
	for _, body := range []string{
		`null`, `[]`, `"name"`, `{}!`,
		`{"name":"a"} {"name":"b"}`, `{"name":"a"} trailing`,
		`{"name":"` + strings.Repeat("a", 1<<20) + `"}`,
	} {
		var in struct{ Name string }
		req := httptest.NewRequest(http.MethodPost, "/", strings.NewReader(body))
		if err := wire.Read(req, &in); !errors.Is(err, fault.Invalid) {
			t.Errorf("Read accepted a malformed or oversized request (%d bytes): %v", len(body), err)
		}
	}
	var in struct{ Name string }
	req := httptest.NewRequest(http.MethodPost, "/", strings.NewReader("{\"name\":\"a\"}\n\t "))
	if err := wire.Read(req, &in); err != nil || in.Name != "a" {
		t.Fatalf("valid JSON followed by whitespace: %+v, %v", in, err)
	}
}

func TestReadOptionalAllowsEmptyBodiesWithoutSkippingValidation(t *testing.T) {
	for _, body := range []string{"", " \n\t", `{}`, `{"id":"record-id"}`} {
		var in struct{ ID string }
		req := httptest.NewRequest(http.MethodPost, "/", strings.NewReader(body))
		// Chunked requests have no known length; validation must inspect the body itself.
		req.ContentLength = -1
		if err := wire.ReadOptional(req, &in); err != nil {
			t.Errorf("ReadOptional(%q) = %v", body, err)
		}
	}
	for _, body := range []string{`null`, `{"unknown":1}`, `{} {}`, strings.Repeat(" ", (1<<20)+1)} {
		var in struct{ ID string }
		req := httptest.NewRequest(http.MethodPost, "/", strings.NewReader(body))
		if err := wire.ReadOptional(req, &in); !errors.Is(err, fault.Invalid) {
			t.Errorf("ReadOptional accepted malformed or oversized body (%d bytes): %v", len(body), err)
		}
	}
}
