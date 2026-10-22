// Package records keeps session records: what each session starts from.
package records

import (
	"cmp"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"slices"
	"syscall"
	"time"

	"github.com/gshpychka/realm/packages/bay/internal/machines"
)

// Record is what a session starts from, and what remains of it once it has ended.
type Record struct {
	// ID identifies the session for as long as its record exists.
	ID      string              `json:"id"`
	Name    string              `json:"name"`
	Program Program             `json:"program"`
	Machine *machines.Selection `json:"machine,omitempty"`
	Repos   []Repo              `json:"repos,omitempty"`
	Created time.Time           `json:"created"`
}

// PinMachine upgrades a legacy record once, before its next fresh instance. A
// record already pinned to a revision cannot be silently moved to another one.
func (s *Store) PinMachine(name string, machine machines.Selection, program *ProgramDefinition) (Record, error) {
	dir, err := s.dir(name)
	if err != nil {
		return Record{}, err
	}
	r, err := read(dir)
	if err != nil {
		return Record{}, err
	}
	if r.Machine != nil {
		if *r.Machine != machine {
			return Record{}, fmt.Errorf("session %s already has a pinned machine", name)
		}
		return r, nil
	}
	r.Machine = &machine
	r.Program.Runtime = program
	data, err := json.MarshalIndent(r, "", "  ")
	if err != nil {
		return Record{}, err
	}
	tmp, err := os.CreateTemp(dir, ".record-")
	if err != nil {
		return Record{}, err
	}
	defer os.Remove(tmp.Name())
	if _, err = tmp.Write(data); err == nil {
		err = tmp.Sync()
	}
	if closeErr := tmp.Close(); err == nil {
		err = closeErr
	}
	if err != nil {
		return Record{}, err
	}
	if err := os.Rename(tmp.Name(), filepath.Join(dir, recordFile)); err != nil {
		return Record{}, err
	}
	if err := syncDir(dir); err != nil {
		return Record{}, err
	}
	return r, nil
}

// Program is the session's program: a definition by name, or a command launched fresh on every start.
type Program struct {
	Definition string   `json:"definition,omitempty"`
	Command    []string `json:"command,omitempty"`
	// Runtime is resolved with the pinned machine; store paths must not drift
	// to commands introduced by a later host configuration.
	Runtime *ProgramDefinition `json:"runtime,omitempty"`
}

type ProgramDefinition struct {
	Command        []string `json:"command"`
	Resume         []string `json:"resume,omitempty"`
	History        []string `json:"history,omitempty"`
	Monitor        bool     `json:"monitor"`
	Connect        []string `json:"connect,omitempty"`
	MaxConnections int      `json:"maxConnections,omitempty"`
}

// Repo is a repo the session can access, checked out at Commit.
type Repo struct {
	Owner string `json:"owner"`
	Name  string `json:"name"`
	// Branch is the local branch pointing at Commit; empty leaves the checkout detached.
	Branch string `json:"branch,omitempty"`
	Commit string `json:"commit"`
}

var (
	ErrNotFound = errors.New("no record")
	ErrExists   = errors.New("record exists")
)

const (
	recordFile  = "record.json"
	historyFile = "history.tar"
)

// Store keeps session records and their program histories.
type Store struct {
	root string
}

// Open returns the store rooted at root, creating root if needed.
func Open(root string) (*Store, error) {
	if err := os.MkdirAll(root, 0o700); err != nil {
		return nil, err
	}
	return &Store{root: root}, nil
}

// Create durably stores a new record and fails with ErrExists if one has the same name.
func (s *Store) Create(r Record) error {
	dir, err := s.dir(r.Name)
	if err != nil {
		return err
	}
	data, err := json.MarshalIndent(r, "", "  ")
	if err != nil {
		return err
	}
	staging, err := os.MkdirTemp(s.root, ".create-")
	if err != nil {
		return err
	}
	defer os.RemoveAll(staging)
	if err := writeFileSync(filepath.Join(staging, recordFile), data); err != nil {
		return err
	}
	if err := os.Chmod(staging, 0o700); err != nil {
		return err
	}
	// rename(2) replaces an empty directory and refuses a populated one, so the name is claimed atomically;
	// os.Rename refuses every existing directory.
	if err := syscall.Rename(staging, dir); err != nil {
		if errors.Is(err, fs.ErrExist) {
			return fmt.Errorf("%w: %s", ErrExists, r.Name)
		}
		return err
	}
	return syncDir(s.root)
}

// Get returns the record named name.
func (s *Store) Get(name string) (Record, error) {
	dir, err := s.dir(name)
	if err != nil {
		return Record{}, err
	}
	return read(dir)
}

// List returns every record, oldest first.
func (s *Store) List() ([]Record, error) {
	entries, err := os.ReadDir(s.root)
	if err != nil {
		return nil, err
	}
	var all []Record
	for _, entry := range entries {
		if !entry.IsDir() || !validName(entry.Name()) {
			continue
		}
		r, err := read(filepath.Join(s.root, entry.Name()))
		if errors.Is(err, ErrNotFound) {
			continue
		}
		if err != nil {
			return nil, err
		}
		all = append(all, r)
	}
	slices.SortFunc(all, func(a, b Record) int { return cmp.Compare(a.Created.UnixNano(), b.Created.UnixNano()) })
	return all, nil
}

// Delete removes the record named name with its history.
func (s *Store) Delete(name string) error {
	dir, err := s.dir(name)
	if err != nil {
		return err
	}
	if _, err := os.Stat(filepath.Join(dir, recordFile)); err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return fmt.Errorf("%w: %s", ErrNotFound, name)
		}
		return err
	}
	if err := os.RemoveAll(dir); err != nil {
		return err
	}
	return syncDir(s.root)
}

// WriteHistory durably replaces the program history of the record named name with the tar archive read from r. An
// empty stream means the program has no history and removes any saved one.
func (s *Store) WriteHistory(name string, r io.Reader) error {
	dir, err := s.dir(name)
	if err != nil {
		return err
	}
	if _, err := read(dir); err != nil {
		return err
	}
	tmp, err := os.CreateTemp(dir, ".history-")
	if err != nil {
		return err
	}
	defer os.Remove(tmp.Name())
	size, err := io.Copy(tmp, r)
	if err != nil {
		tmp.Close()
		return err
	}
	history := filepath.Join(dir, historyFile)
	if size == 0 {
		tmp.Close()
		if err := os.Remove(history); err != nil && !errors.Is(err, fs.ErrNotExist) {
			return err
		}
		return syncDir(dir)
	}
	if err := tmp.Sync(); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	if err := os.Rename(tmp.Name(), history); err != nil {
		return err
	}
	return syncDir(dir)
}

// History opens the program history of the record named name, a tar archive; ErrNotFound means none was saved.
func (s *Store) History(name string) (io.ReadCloser, error) {
	dir, err := s.dir(name)
	if err != nil {
		return nil, err
	}
	f, err := os.Open(filepath.Join(dir, historyFile))
	if errors.Is(err, fs.ErrNotExist) {
		return nil, fmt.Errorf("%w: no history for %s", ErrNotFound, name)
	}
	return f, err
}

func (s *Store) dir(name string) (string, error) {
	if !validName(name) {
		return "", fmt.Errorf("invalid record name %q", name)
	}
	return filepath.Join(s.root, name), nil
}

// validName admits one path element, which keeps every record inside the store's root, and reserves a leading dot
// for the store's staging entries.
func validName(name string) bool {
	return name != "" && name != "." && name != ".." && filepath.Base(name) == name && name[0] != '.'
}

func read(dir string) (Record, error) {
	data, err := os.ReadFile(filepath.Join(dir, recordFile))
	if errors.Is(err, fs.ErrNotExist) {
		return Record{}, fmt.Errorf("%w: %s", ErrNotFound, filepath.Base(dir))
	}
	if err != nil {
		return Record{}, err
	}
	var r Record
	if err := json.Unmarshal(data, &r); err != nil {
		return Record{}, fmt.Errorf("record %s: %w", filepath.Base(dir), err)
	}
	return r, nil
}

func writeFileSync(path string, data []byte) error {
	f, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		return err
	}
	_, err = f.Write(data)
	if err == nil {
		err = f.Sync()
	}
	if closeErr := f.Close(); err == nil {
		err = closeErr
	}
	return err
}

// syncDir makes the renames and removals in the directory at path durable.
func syncDir(path string) error {
	d, err := os.Open(path)
	if err != nil {
		return err
	}
	err = d.Sync()
	if closeErr := d.Close(); err == nil {
		err = closeErr
	}
	return err
}
