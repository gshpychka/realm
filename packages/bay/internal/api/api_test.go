package api

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

type suspendService struct {
	Service
	called bool
	name   string
	option Suspend
}

func (s *suspendService) Suspend(_ context.Context, name string, option Suspend) error {
	s.called, s.name, s.option = true, name, option
	return nil
}

func TestSuspendAcceptsLegacyEmptyBodyAndRecordPrecondition(t *testing.T) {
	for _, test := range []struct {
		body string
		id   string
	}{
		{"", ""}, {" \n\t", ""}, {`{}`, ""}, {`{"id":"record-id"}`, "record-id"},
	} {
		t.Run(test.body, func(t *testing.T) {
			svc := &suspendService{}
			req := httptest.NewRequest(http.MethodPost, "/v1/sessions/one/suspend", strings.NewReader(test.body))
			req.ContentLength = -1
			response := httptest.NewRecorder()
			Handler(svc, http.NotFoundHandler()).ServeHTTP(response, req)
			if response.Code != http.StatusOK || !svc.called || svc.name != "one" || svc.option.ID != test.id {
				t.Fatalf("status %d, called %v, name %q, options %+v", response.Code, svc.called, svc.name, svc.option)
			}
		})
	}
}
