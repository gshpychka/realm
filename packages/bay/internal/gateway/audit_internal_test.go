package gateway

import (
	"bytes"
	"errors"
	"log/slog"
	"strings"
	"testing"
	"unicode/utf8"

	"github.com/gshpychka/realm/packages/bay/internal/fault"
)

func TestAuditClipsSessionSuppliedValues(t *testing.T) {
	var out bytes.Buffer
	log := slog.New(slog.NewTextHandler(&out, nil))
	long := strings.Repeat("é", 1<<16)
	audit(log, "one", long, errors.Join(fault.NotFound, errors.New(long)), "to", long)
	if out.Len() > 4*maxValue {
		t.Fatalf("one audit record took %d bytes", out.Len())
	}
	if !utf8.Valid(out.Bytes()) {
		t.Fatal("clipping split a rune")
	}
}
