package records

import (
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func testRecord(name string, created time.Time) Record {
	return Record{
		ID:      "id-" + name,
		Name:    name,
		Program: Program{Definition: "claude"},
		Repos:   []Repo{{Owner: "o", Name: "r", Branch: "main", Commit: "abc"}},
		Created: created,
	}
}

func TestCreateGetList(t *testing.T) {
	s, err := Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	now := time.Date(2026, 10, 5, 12, 0, 0, 0, time.UTC)
	if err := s.Create(testRecord("b", now.Add(time.Minute))); err != nil {
		t.Fatal(err)
	}
	if err := s.Create(testRecord("a", now)); err != nil {
		t.Fatal(err)
	}
	got, err := s.Get("b")
	if err != nil {
		t.Fatal(err)
	}
	if got.ID != "id-b" || got.Repos[0].Commit != "abc" || !got.Created.Equal(now.Add(time.Minute)) {
		t.Fatalf("Get returned %+v", got)
	}
	all, err := s.List()
	if err != nil {
		t.Fatal(err)
	}
	if len(all) != 2 || all[0].Name != "a" || all[1].Name != "b" {
		t.Fatalf("List returned %+v, want a then b", all)
	}
}

func TestCreateRefusesTakenName(t *testing.T) {
	s, _ := Open(t.TempDir())
	if err := s.Create(testRecord("a", time.Now())); err != nil {
		t.Fatal(err)
	}
	if err := s.Create(testRecord("a", time.Now())); !errors.Is(err, ErrExists) {
		t.Fatalf("second Create returned %v, want ErrExists", err)
	}
}

func TestCreateClaimsEmptyDirectory(t *testing.T) {
	root := t.TempDir()
	s, _ := Open(root)
	if err := os.Mkdir(filepath.Join(root, "a"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := s.Create(testRecord("a", time.Now())); err != nil {
		t.Fatalf("Create over an empty directory: %v", err)
	}
}

func TestGetMissing(t *testing.T) {
	s, _ := Open(t.TempDir())
	if _, err := s.Get("nope"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("Get returned %v, want ErrNotFound", err)
	}
}

func TestExecutionGenerationAdvancesAndSurvivesReopen(t *testing.T) {
	root := t.TempDir()
	s, err := Open(root)
	if err != nil {
		t.Fatal(err)
	}
	initial := testRecord("old", time.Now())
	initial.Generation = 1
	if err := s.Create(initial); err != nil {
		t.Fatal(err)
	}
	before, err := s.Get("old")
	if err != nil || before.Generation != 1 {
		t.Fatalf("initial generation: %+v, %v", before, err)
	}
	if _, err := s.AdvanceGeneration("old"); err != nil {
		t.Fatal(err)
	}
	s, err = Open(root)
	if err != nil {
		t.Fatal(err)
	}
	reopened, err := s.Get("old")
	if err != nil || reopened.Generation != 2 || reopened.ID != before.ID {
		t.Fatalf("durable generation: %+v, %v", reopened, err)
	}
}

func TestRejectsPathNames(t *testing.T) {
	s, _ := Open(t.TempDir())
	for _, name := range []string{"", ".", "..", "../x", "a/b", ".hidden"} {
		if err := s.Create(testRecord(name, time.Now())); err == nil {
			t.Errorf("Create(%q) succeeded", name)
		}
	}
}

func TestHistory(t *testing.T) {
	s, _ := Open(t.TempDir())
	if err := s.Create(testRecord("a", time.Now())); err != nil {
		t.Fatal(err)
	}
	if _, err := s.History("a"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("History before any save returned %v, want ErrNotFound", err)
	}
	for _, content := range []string{"first", "second"} {
		if err := s.WriteHistory("a", strings.NewReader(content)); err != nil {
			t.Fatal(err)
		}
	}
	r, err := s.History("a")
	if err != nil {
		t.Fatal(err)
	}
	defer r.Close()
	data, _ := io.ReadAll(r)
	if string(data) != "second" {
		t.Fatalf("History returned %q, want the latest save", data)
	}
	if err := s.WriteHistory("missing", strings.NewReader("x")); !errors.Is(err, ErrNotFound) {
		t.Fatalf("WriteHistory without a record returned %v, want ErrNotFound", err)
	}
}

func TestWriteHistoryOfNothingRemovesTheHistory(t *testing.T) {
	root := t.TempDir()
	s, _ := Open(root)
	if err := s.Create(testRecord("a", time.Now())); err != nil {
		t.Fatal(err)
	}
	if err := s.WriteHistory("a", strings.NewReader("")); err != nil {
		t.Fatalf("WriteHistory of an empty stream over no history: %v", err)
	}
	if _, err := s.History("a"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("History after an empty save returned %v, want ErrNotFound", err)
	}
	if err := s.WriteHistory("a", strings.NewReader("first")); err != nil {
		t.Fatal(err)
	}
	if err := s.WriteHistory("a", strings.NewReader("")); err != nil {
		t.Fatalf("WriteHistory of an empty stream over saved history: %v", err)
	}
	if _, err := s.History("a"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("History after an empty save returned %v, want ErrNotFound", err)
	}
	if got := entries(t, filepath.Join(root, "a")); strings.Join(got, " ") != recordFile {
		t.Fatalf("record directory holds %v, want only the record", got)
	}
}

type failingReader struct{ err error }

func (r failingReader) Read([]byte) (int, error) { return 0, r.err }

func TestWriteHistoryKeepsTheSavedOneWhenTheStreamFails(t *testing.T) {
	root := t.TempDir()
	s, _ := Open(root)
	if err := s.Create(testRecord("a", time.Now())); err != nil {
		t.Fatal(err)
	}
	if err := s.WriteHistory("a", strings.NewReader("first")); err != nil {
		t.Fatal(err)
	}
	boom := errors.New("boom")
	for _, stream := range []io.Reader{failingReader{boom}, io.MultiReader(strings.NewReader("partial"), failingReader{boom})} {
		if err := s.WriteHistory("a", stream); !errors.Is(err, boom) {
			t.Fatalf("WriteHistory of a failing stream returned %v, want its error", err)
		}
		r, err := s.History("a")
		if err != nil {
			t.Fatal(err)
		}
		data, _ := io.ReadAll(r)
		r.Close()
		if string(data) != "first" {
			t.Fatalf("History returned %q after a failed save, want the previous one", data)
		}
		if got := entries(t, filepath.Join(root, "a")); strings.Join(got, " ") != historyFile+" "+recordFile {
			t.Fatalf("record directory holds %v after a failed save", got)
		}
	}
}

// entries returns the sorted names in dir.
func entries(t *testing.T, dir string) []string {
	t.Helper()
	all, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	var names []string
	for _, e := range all {
		names = append(names, e.Name())
	}
	return names
}

func TestDelete(t *testing.T) {
	s, _ := Open(t.TempDir())
	if err := s.Create(testRecord("a", time.Now())); err != nil {
		t.Fatal(err)
	}
	if err := s.WriteHistory("a", strings.NewReader("h")); err != nil {
		t.Fatal(err)
	}
	if err := s.Delete("a"); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Get("a"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("Get after Delete returned %v", err)
	}
	if err := s.Delete("a"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("second Delete returned %v, want ErrNotFound", err)
	}
	if err := s.Create(testRecord("a", time.Now())); err != nil {
		t.Fatalf("Create after Delete: %v", err)
	}
}
