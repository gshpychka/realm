// Package fault names the kinds of failure Bay's components report to each other.
package fault

import "errors"

var (
	// NotFound: the thing asked about does not exist.
	NotFound = errors.New("not found")
	// Conflict: the request is valid but the current state refuses it.
	Conflict = errors.New("conflict")
	// Capacity refuses admission before allocating a new instance. It remains a Conflict for existing clients.
	Capacity = capacityFault{}
	// Invalid: the request itself is malformed.
	Invalid = errors.New("invalid")
	// Forbidden: the caller may not do this.
	Forbidden = errors.New("forbidden")
)

const (
	CapacityExhaustedCode = "capacity_exhausted"
	// LaunchRejectedCode guarantees that a fresh start failed validation before creating a session record or instance.
	LaunchRejectedCode = "launch_rejected"
)

type capacityFault struct{}

func (capacityFault) Error() string     { return Conflict.Error() }
func (capacityFault) Unwrap() error     { return Conflict }
func (capacityFault) FaultCode() string { return CapacityExhaustedCode }

type codedFault struct {
	err  error
	code string
}

func (e codedFault) Error() string     { return e.err.Error() }
func (e codedFault) Unwrap() error     { return e.err }
func (e codedFault) FaultCode() string { return e.code }

// WithCode adds a machine-readable code without changing err's text or fault kind.
func WithCode(err error, code string) error {
	if err == nil {
		return nil
	}
	return codedFault{err: err, code: code}
}

// Code returns the nearest machine-readable code carried by err, or an empty string.
func Code(err error) string {
	var coded interface{ FaultCode() string }
	if errors.As(err, &coded) {
		return coded.FaultCode()
	}
	return ""
}

// Kind returns the fault kind that err wraps, or nil when err wraps none. An error that wraps several kinds reports the
// first in the order NotFound, Conflict, Invalid, Forbidden.
func Kind(err error) error {
	for _, kind := range []error{NotFound, Conflict, Invalid, Forbidden} {
		if errors.Is(err, kind) {
			return kind
		}
	}
	return nil
}
