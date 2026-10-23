package activation

import (
	"os"
	"strconv"
	"testing"
)

func TestPassedRejectsMalformedSocketMetadata(t *testing.T) {
	for _, tt := range []struct{ count, names string }{
		{"-1", "api"}, {"0", ""}, {"bad", "api"}, {"2", "api"},
		{"2", "api:api"}, {"2", "api:"},
	} {
		t.Run(tt.count+"/"+tt.names, func(t *testing.T) {
			t.Setenv("LISTEN_PID", strconv.Itoa(os.Getpid()))
			t.Setenv("LISTEN_FDS", tt.count)
			t.Setenv("LISTEN_FDNAMES", tt.names)
			if sockets, err := Passed(); err == nil || sockets != nil {
				t.Fatalf("Passed = %v, %v; want invalid metadata rejected before opening descriptors", sockets, err)
			}
		})
	}
}
