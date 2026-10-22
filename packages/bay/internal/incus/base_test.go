package incus

import (
	"crypto/sha256"
	"encoding/hex"
	"os"
	"path/filepath"
	"testing"
)

func TestFingerprintFiles(t *testing.T) {
	dir := t.TempDir()
	metadata, disk := filepath.Join(dir, "metadata.tar.xz"), filepath.Join(dir, "disk.qcow2")
	for path, content := range map[string]string{metadata: "metadata", disk: "disk"} {
		if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	sum := sha256.Sum256([]byte("metadatadisk"))
	want := hex.EncodeToString(sum[:])
	if got, err := fingerprintFiles(metadata, disk); err != nil || got != want {
		t.Fatalf("fingerprintFiles(metadata, disk) = %q, %v; want %q", got, err, want)
	}
	if got, _ := fingerprintFiles(disk, metadata); got == want {
		t.Fatal("the fingerprint ignores the order of the files")
	}
	if _, err := fingerprintFiles(metadata, filepath.Join(dir, "missing")); err == nil {
		t.Fatal("fingerprintFiles of a missing file succeeded")
	}
}

func TestHeadKeepsTheStartOfALongStream(t *testing.T) {
	h := &head{max: 4}
	for _, chunk := range []string{"ab", "cdef", "gh"} {
		if n, err := h.Write([]byte(chunk)); n != len(chunk) || err != nil {
			t.Fatalf("Write(%q) = %d, %v; want every byte accepted", chunk, n, err)
		}
	}
	if got := h.String(); got != "abcd (truncated)" {
		t.Fatalf("String() = %q", got)
	}
}
