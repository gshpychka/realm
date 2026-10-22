package gateway

import (
	"testing"
	"time"
)

func TestAllowancesRefillOverTime(t *testing.T) {
	const burst, refill = 3, time.Minute
	allowances := newAllowances[string](burst, refill)
	start := time.Date(2026, 10, 6, 9, 0, 0, 0, time.UTC)

	for i := range burst {
		if !allowances.allow("alice", start) {
			t.Fatalf("act %d of the first %d was refused", i+1, burst)
		}
	}
	if allowances.allow("alice", start) {
		t.Errorf("act %d at once was allowed", burst+1)
	}
	if !allowances.allow("bob", start) {
		t.Error("alice's acts used up bob's allowance")
	}
	if allowances.allow("alice", start.Add(refill/2)) {
		t.Errorf("an act half a refill later was allowed")
	}
	if !allowances.allow("alice", start.Add(refill)) {
		t.Errorf("no act was allowed once %s had passed", refill)
	}
	if allowances.allow("alice", start.Add(refill)) {
		t.Errorf("one refill gave back more than one act")
	}
	// A long quiet spell refills the allowance up to the burst and no further.
	later := start.Add(24 * time.Hour)
	for i := range burst {
		if !allowances.allow("alice", later) {
			t.Fatalf("act %d after a quiet day was refused", i+1)
		}
	}
	if allowances.allow("alice", later) {
		t.Errorf("a quiet day gave more than %d acts", burst)
	}
}
