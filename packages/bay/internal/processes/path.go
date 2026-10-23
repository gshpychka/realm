package processes

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// Executable resolves against the command's actual environment, rather than
// the operator's environment at exec.Command construction time.
func Executable(name string, environment []string, cwd string) (string, error) {
	if strings.ContainsRune(name, '/') {
		return name, nil
	}
	path := ""
	for _, entry := range environment {
		if strings.HasPrefix(entry, "PATH=") {
			path = strings.TrimPrefix(entry, "PATH=")
		}
	}
	for _, dir := range filepath.SplitList(path) {
		candidate := filepath.Join(dir, name)
		if !filepath.IsAbs(candidate) {
			candidate = filepath.Join(cwd, candidate)
		}
		st, err := os.Stat(candidate)
		if err == nil && st.Mode().IsRegular() && st.Mode().Perm()&0111 != 0 {
			return candidate, nil
		}
	}
	return "", fmt.Errorf("executable not found in command PATH: %s", name)
}
