package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
)

// Store keeps each room in its own JSON file under DATA_DIR/rooms.
type Store struct {
	dir string
}

// OpenStore prepares the rooms directory inside dataDir.
func OpenStore(dataDir string) (*Store, error) {
	dir := filepath.Join(dataDir, "rooms")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, err
	}
	return &Store{dir: dir}, nil
}

// Save writes the room to a temporary file and renames it into place, so that
// a crash never leaves a half-written room behind.
func (s *Store) Save(st State) error {
	data, err := json.Marshal(st)
	if err != nil {
		return err
	}
	f, err := os.CreateTemp(s.dir, st.ID+".*.tmp")
	if err != nil {
		return err
	}
	tmp := f.Name()
	_, err = f.Write(data)
	if err == nil {
		err = f.Sync()
	}
	if closeErr := f.Close(); err == nil {
		err = closeErr
	}
	if err == nil {
		err = os.Rename(tmp, s.path(st.ID))
	}
	if err != nil {
		os.Remove(tmp)
	}
	return err
}

// Delete removes a room's file.
func (s *Store) Delete(id string) error {
	err := os.Remove(s.path(id))
	if errors.Is(err, fs.ErrNotExist) {
		return nil
	}
	return err
}

// LoadAll reads every saved room. A file that cannot be read stops the server,
// so that a room is never dropped without anyone noticing.
func (s *Store) LoadAll() ([]State, error) {
	entries, err := os.ReadDir(s.dir)
	if err != nil {
		return nil, err
	}
	var states []State
	for _, e := range entries {
		name := e.Name()
		if strings.HasSuffix(name, ".tmp") {
			// Left over from a save that was cut short; the room's previous file is intact.
			os.Remove(filepath.Join(s.dir, name))
			continue
		}
		id, ok := strings.CutSuffix(name, ".json")
		if !ok {
			continue
		}
		data, err := os.ReadFile(filepath.Join(s.dir, name))
		if err != nil {
			return nil, err
		}
		var st State
		if err := json.Unmarshal(data, &st); err != nil {
			return nil, fmt.Errorf("read %s: %w", filepath.Join(s.dir, name), err)
		}
		if st.ID != id || !roomIDPattern.MatchString(id) {
			return nil, fmt.Errorf("read %s: the file holds room %q", filepath.Join(s.dir, name), st.ID)
		}
		states = append(states, st)
	}
	return states, nil
}

func (s *Store) path(id string) string {
	return filepath.Join(s.dir, id+".json")
}
