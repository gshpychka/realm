package api

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gshpychka/realm/packages/bay/internal/identity"
	"github.com/gshpychka/realm/packages/bay/internal/operations"
)

type operationsStub struct {
	Service
	called   bool
	expected identity.Precondition
	input    string
}

func (s *operationsStub) PutBlob(_ context.Context, _ string, expected identity.Precondition, digest string, r io.Reader) (operations.Blob, error) {
	s.called = true
	s.expected = expected
	data, err := io.ReadAll(r)
	s.input = string(data)
	return operations.Blob{SHA256: digest, Size: int64(len(data)), Path: "/var/lib/bay/blobs/" + digest}, err
}

func TestOperatorBlobRouteRequiresBothPinsAndStreamsOnlyToOperatorService(t *testing.T) {
	for _, pinned := range []bool{false, true} {
		svc := &operationsStub{}
		request := httptest.NewRequest(http.MethodPut, "/v1/sessions/one/blobs/"+strings.Repeat("a", 64), strings.NewReader("raw bundle bytes"))
		if pinned {
			request.Header.Set(SessionIDHeader, "record-one")
			request.Header.Set(SessionGenerationHeader, "3")
		}
		response := httptest.NewRecorder()
		Handler(svc, http.NotFoundHandler()).ServeHTTP(response, request)
		if !pinned {
			if response.Code != http.StatusBadRequest || svc.called {
				t.Fatalf("unfenced upload reached service: %d %v", response.Code, svc.called)
			}
			continue
		}
		if response.Code != http.StatusOK || !svc.called || svc.expected.ID != "record-one" || svc.expected.Generation == nil || *svc.expected.Generation != 3 || svc.input != "raw bundle bytes" {
			t.Fatalf("upload contract: %d %+v %q", response.Code, svc.expected, svc.input)
		}
		if response.Header().Get(SessionIDHeader) != "record-one" || response.Header().Get(SessionGenerationHeader) != "3" {
			t.Fatal("response lost session pins")
		}
	}
}
