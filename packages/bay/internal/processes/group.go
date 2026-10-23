// Package processes contains command lifetime boundaries shared by Bay's
// disposable environments and durable operator jobs.
package processes

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"time"
)

// Commands enter their subgroup at clone time, before any user code can fork.
// The operator owns both the parent and subgroup; the command account cannot
// migrate into the parent or leave descendants outside the lifetime boundary.
func NewGroup() (*os.File, func() error, error) {
	data, err := os.ReadFile("/proc/self/cgroup")
	if err != nil {
		return nil, nil, err
	}
	relative := ""
	for _, line := range strings.Split(string(data), "\n") {
		if strings.HasPrefix(line, "0::") {
			relative = strings.TrimPrefix(line, "0::")
			break
		}
	}
	if relative == "" {
		return nil, nil, fmt.Errorf("operator commands require cgroup v2")
	}
	path, err := os.MkdirTemp(filepath.Join("/sys/fs/cgroup", strings.TrimPrefix(relative, "/")), "command-")
	if err != nil {
		return nil, nil, fmt.Errorf("create command group: %w", err)
	}
	dir, err := os.Open(path)
	if err != nil {
		os.Remove(path)
		return nil, nil, err
	}
	done := false
	var cleanupErr error
	cleanup := func() error {
		if done {
			return cleanupErr
		}
		done = true
		dir.Close()
		for range 40 {
			if err := os.Remove(path); err == nil || os.IsNotExist(err) {
				return nil
			}
			time.Sleep(25 * time.Millisecond)
		}
		cleanupErr = fmt.Errorf("command control group did not become empty")
		return cleanupErr
	}

	return dir, cleanup, nil
}
func KillGroup(dir *os.File, pid int) error {
	if dir != nil {
		return os.WriteFile(filepath.Join(dir.Name(), "cgroup.kill"), []byte("1"), 0600)
	}
	// Only in-process source tests omit cgroups. Production always supplies a
	// real subgroup or rejects the command before starting it.
	if pid > 0 {
		return syscall.Kill(-pid, syscall.SIGKILL)
	}
	return nil
}
