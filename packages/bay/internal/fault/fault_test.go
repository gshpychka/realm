package fault_test

import (
	"errors"
	"fmt"
	"testing"

	"github.com/gshpychka/realm/packages/bay/internal/fault"
)

func TestKind(t *testing.T) {
	tests := []struct {
		name string
		err  error
		want error
	}{
		{"nil", nil, nil},
		{"a plain error", errors.New("disk gone"), nil},
		{"not found", fault.NotFound, fault.NotFound},
		{"conflict", fault.Conflict, fault.Conflict},
		{"invalid", fault.Invalid, fault.Invalid},
		{"forbidden", fault.Forbidden, fault.Forbidden},
		{"wrapped once", fmt.Errorf("%w: thread 7", fault.NotFound), fault.NotFound},
		{"wrapped twice", fmt.Errorf("send: %w", fmt.Errorf("%w: thread 7", fault.Forbidden)), fault.Forbidden},
		{"a plain error around a kind", fmt.Errorf("%v: %w", errors.New("context"), fault.Conflict), fault.Conflict},
		{"only the text of a kind", errors.New("not found"), nil},
		{"several kinds", errors.Join(fault.Forbidden, fault.Invalid, fault.NotFound), fault.NotFound},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := fault.Kind(tt.err); got != tt.want {
				t.Errorf("Kind(%v) = %v, want %v", tt.err, got, tt.want)
			}
		})
	}
}
