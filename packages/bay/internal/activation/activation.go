// Package activation hands a service the sockets systemd opened for it.
package activation

import (
	"errors"
	"fmt"
	"net"
	"os"
	"strconv"
	"strings"
)

// firstFD is the descriptor of the first passed socket; see sd_listen_fds(3).
const firstFD = 3

// Sockets are the sockets systemd passed to this process, keyed by their FileDescriptorName.
type Sockets map[string]*os.File

// Passed returns the sockets systemd passed to this process.
func Passed() (Sockets, error) {
	pid, err := strconv.Atoi(os.Getenv("LISTEN_PID"))
	if err != nil || pid != os.Getpid() {
		return nil, errors.New("systemd passed no sockets to this process")
	}
	count, err := strconv.Atoi(os.Getenv("LISTEN_FDS"))
	if err != nil {
		return nil, fmt.Errorf("parse LISTEN_FDS: %w", err)
	}
	names := strings.Split(os.Getenv("LISTEN_FDNAMES"), ":")
	if len(names) != count {
		return nil, fmt.Errorf("LISTEN_FDNAMES names %d sockets, LISTEN_FDS passes %d", len(names), count)
	}
	sockets := make(Sockets, count)
	for i, name := range names {
		sockets[name] = os.NewFile(uintptr(firstFD+i), name)
	}
	return sockets, nil
}

// File returns the socket called name.
func (s Sockets) File(name string) (*os.File, error) {
	f, ok := s[name]
	if !ok {
		return nil, fmt.Errorf("systemd passed no socket named %q", name)
	}
	return f, nil
}

// Listener returns the stream socket called name as a net.Listener.
func (s Sockets) Listener(name string) (net.Listener, error) {
	f, err := s.File(name)
	if err != nil {
		return nil, err
	}
	l, err := net.FileListener(f)
	if err != nil {
		return nil, fmt.Errorf("socket %q: %w", name, err)
	}
	f.Close()
	return l, nil
}
