package gateway

import (
	"sync"
	"time"

	"golang.org/x/time/rate"
)

// allowances gives each key its own allowance of acts: burst at once, and one more each refill.
type allowances[K comparable] struct {
	burst  int
	refill time.Duration

	mu       sync.Mutex
	limiters map[K]*rate.Limiter
}

func newAllowances[K comparable](burst int, refill time.Duration) *allowances[K] {
	return &allowances[K]{burst: burst, refill: refill, limiters: map[K]*rate.Limiter{}}
}

// allow reports whether key may act at time at, and counts the act against its allowance when it may.
func (a *allowances[K]) allow(key K, at time.Time) bool {
	a.mu.Lock()
	defer a.mu.Unlock()
	limiter, ok := a.limiters[key]
	if !ok {
		limiter = rate.NewLimiter(rate.Every(a.refill), a.burst)
		a.limiters[key] = limiter
	}
	return limiter.AllowN(at, 1)
}
