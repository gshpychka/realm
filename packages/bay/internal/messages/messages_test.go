package messages_test

import (
	"errors"
	"io"
	"strings"
	"testing"

	"github.com/gshpychka/realm/packages/bay/internal/fault"
	"github.com/gshpychka/realm/packages/bay/internal/messages"
)

type endless struct{ read int }

func (r *endless) Read(p []byte) (int, error) {
	for i := range p {
		p[i] = 'x'
	}
	r.read += len(p)
	return len(p), nil
}

func TestReadBodyBoundsInput(t *testing.T) {
	r := &endless{}
	if _, err := messages.ReadBody(r); !errors.Is(err, fault.Invalid) || r.read > messages.MaxBody+1 {
		t.Fatalf("ReadBody = %v after %d bytes; want bounded invalid body", err, r.read)
	}
	want := strings.Repeat("x", messages.MaxBody)
	if got, err := messages.ReadBody(strings.NewReader(want)); err != nil || got != want {
		t.Fatalf("body at the limit: %d bytes, %v", len(got), err)
	}
	if _, err := messages.ReadBody(io.MultiReader(strings.NewReader("partial"), failedReader{})); !errors.Is(err, io.ErrUnexpectedEOF) {
		t.Fatalf("ReadBody hid an input error: %v", err)
	}
}

type failedReader struct{}

func (failedReader) Read([]byte) (int, error) { return 0, io.ErrUnexpectedEOF }
