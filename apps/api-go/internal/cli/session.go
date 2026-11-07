package cli

import (
	"encoding/json"
	"errors"
	"io/fs"
	"os"
	"path/filepath"
)

const sessionSchema = "sipgesctl-session/v1"

// session is what stays on disk between commands. It holds a live credential, so it lives in a
// file only its owner can read, and it names the API it belongs to: the cookie is never sent to
// another address.
type session struct {
	Schema   string            `json:"schema"`
	URL      string            `json:"url"`
	Username string            `json:"username,omitempty"`
	Cookies  map[string]string `json:"cookies"`
}

func defaultSessionFile(env func(string) string) (string, error) {
	if dir := env("XDG_STATE_HOME"); dir != "" {
		return filepath.Join(dir, "sipges", "session.json"), nil
	}
	home := env("HOME")
	if home == "" {
		return "", localError("no HOME: pass --session-file")
	}
	return filepath.Join(home, ".local", "state", "sipges", "session.json"), nil
}

// loadSession returns nil when there is no file. A file others can read is refused, not repaired:
// its cookie may already have been read.
func loadSession(path string) (*session, error) {
	info, err := os.Stat(path)
	if errors.Is(err, fs.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, localError("read the session file: %v", err)
	}
	if info.Mode().Perm()&0o077 != 0 {
		return nil, localError("the session file %s can be read by others: remove it and sign in again", path)
	}
	body, err := os.ReadFile(path) //nolint:gosec // the path is the caller's own session file
	if err != nil {
		return nil, localError("read the session file: %v", err)
	}
	var loaded session
	if err := json.Unmarshal(body, &loaded); err != nil || loaded.Schema != sessionSchema {
		return nil, localError("the session file %s is not one of ours: remove it and sign in again", path)
	}
	return &loaded, nil
}

// saveSession replaces the file in one step, so a failed write leaves the old session whole.
func saveSession(path string, s *session) error {
	s.Schema = sessionSchema
	body, err := json.Marshal(s)
	if err != nil {
		return localError("write the session file: %v", err)
	}
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return localError("create the session folder: %v", err)
	}
	temp, err := os.CreateTemp(dir, ".session-*")
	if err != nil {
		return localError("write the session file: %v", err)
	}
	defer func() { _ = os.Remove(temp.Name()) }()
	// CreateTemp already makes the file 0600; a failed write must not leave it half done.
	if _, err := temp.Write(body); err != nil {
		_ = temp.Close()
		return localError("write the session file: %v", err)
	}
	if err := temp.Close(); err != nil {
		return localError("write the session file: %v", err)
	}
	if err := os.Rename(temp.Name(), path); err != nil {
		return localError("write the session file: %v", err)
	}
	return nil
}

func removeSession(path string) error {
	if err := os.Remove(path); err != nil && !errors.Is(err, fs.ErrNotExist) {
		return localError("remove the session file: %v", err)
	}
	return nil
}
