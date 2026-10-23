package processes

import (
	"os"
	"path/filepath"
	"testing"
)

func TestExecutableUsesTheCommandEnvironmentAndRelativePathEntries(t *testing.T) {
	root := t.TempDir()
	for _, directory := range []string{"operator", "command"} {
		if err := os.Mkdir(filepath.Join(root, directory), 0700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(root, directory, "tool"), []byte("tool"), 0700); err != nil {
			t.Fatal(err)
		}
	}
	t.Setenv("PATH", filepath.Join(root, "operator"))
	path, err := Executable("tool", []string{"PATH=operator", "PATH=command"}, root)
	if err != nil || path != filepath.Join(root, "command", "tool") {
		t.Fatalf("command used another environment's executable: %s %v", path, err)
	}
	if _, err := Executable("tool", nil, root); err == nil {
		t.Fatal("an empty command environment inherited the operator PATH")
	}
}
