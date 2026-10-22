// Package fault names the kinds of failure Bay's components report to each other.
package fault

import "errors"

var (
	// NotFound: the thing asked about does not exist.
	NotFound = errors.New("not found")
	// Conflict: the request is valid but the current state refuses it.
	Conflict = errors.New("conflict")
	// Invalid: the request itself is malformed.
	Invalid = errors.New("invalid")
	// Forbidden: the caller may not do this.
	Forbidden = errors.New("forbidden")
)

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
