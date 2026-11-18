package main

import (
	"bytes"
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/Dreamcoder08/sipges/apps/api-go/internal/platform/desktopupdate"
)

// field is one field of a log line, kept in the order launcher.mjs writes it.
type field struct {
	key   string
	value any
}

// eventLog writes launcher.mjs's JSON lines: {"time":…,"event":…,…fields}.
type eventLog struct {
	mu sync.Mutex
	w  io.Writer
}

func newEventLog(w io.Writer) *eventLog { return &eventLog{w: w} }

// isoTime is JavaScript's Date#toISOString.
func isoTime(t time.Time) string { return t.UTC().Format("2006-01-02T15:04:05.000Z") }

func (l *eventLog) event(name string, fields ...field) {
	var b bytes.Buffer
	b.WriteString(`{"time":`)
	b.Write(jsonValue(isoTime(time.Now())))
	b.WriteString(`,"event":`)
	b.Write(jsonValue(name))
	for _, f := range fields {
		b.WriteByte(',')
		b.Write(jsonValue(f.key))
		b.WriteByte(':')
		b.Write(jsonValue(f.value))
	}
	b.WriteString("}\n")
	l.mu.Lock()
	defer l.mu.Unlock()
	_, _ = l.w.Write(b.Bytes())
}

// jsonValue encodes as JSON.stringify would: no HTML escaping.
func jsonValue(v any) []byte {
	var b bytes.Buffer
	enc := json.NewEncoder(&b)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(v); err != nil {
		return []byte("null")
	}
	return bytes.TrimRight(b.Bytes(), "\n")
}

// writeJSONAtomic writes JSON.stringify(value, null, 2) + "\n" into a new temporary file beside
// path (mode 0600, never an existing file) and renames it over path.
func writeJSONAtomic(path string, value any) error {
	var b bytes.Buffer
	enc := json.NewEncoder(&b)
	enc.SetEscapeHTML(false)
	enc.SetIndent("", "  ")
	if err := enc.Encode(value); err != nil {
		return err
	}
	id := make([]byte, 16)
	if _, err := rand.Read(id); err != nil {
		return err
	}
	temporary := path + "." + hex.EncodeToString(id) + ".tmp"
	file, err := os.OpenFile(temporary, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600) //nolint:gosec // beside the install root's own file
	if err != nil {
		return err
	}
	_, err = file.Write(b.Bytes())
	if closeErr := file.Close(); err == nil {
		err = closeErr
	}
	if err == nil {
		err = desktopupdate.RenameRetry(temporary, path)
	}
	if err != nil {
		_ = os.Remove(temporary)
	}
	return err
}

// hasContent reports whether a file exists and holds more than white space.
func hasContent(path string) (bool, error) {
	data, err := os.ReadFile(path) //nolint:gosec // the state folder's own secret
	if errors.Is(err, fs.ErrNotExist) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	return strings.TrimSpace(string(data)) != "", nil
}

// prepareState creates the state folder and each missing secret once, as launcher.mjs
// prepareState does: an existing secret is never rewritten, a blank one is replaced.
func prepareState(stateDir string) error {
	if err := os.MkdirAll(filepath.Join(stateDir, "uploads"), 0o700); err != nil {
		return err
	}
	if err := os.Chmod(stateDir, 0o700); err != nil { //nolint:gosec // G302: a folder needs its search bit; owner only
		return err
	}
	secrets := []struct {
		name string
		make func() (string, error)
	}{
		{"data-key", func() (string, error) { return randomText(32, base64.StdEncoding) }},
		{"admin-password", func() (string, error) { return randomText(18, base64.RawURLEncoding) }},
	}
	for _, s := range secrets {
		path := filepath.Join(stateDir, s.name)
		ok, err := hasContent(path)
		if err != nil {
			return err
		}
		if !ok {
			value, err := s.make()
			if err != nil {
				return err
			}
			if err := os.WriteFile(path, []byte(value+"\n"), 0o600); err != nil {
				return fmt.Errorf("write %s: %w", s.name, err)
			}
		}
		if err := os.Chmod(path, 0o600); err != nil {
			return err
		}
	}
	return nil
}

func randomText(n int, enc *base64.Encoding) (string, error) {
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return enc.EncodeToString(b), nil
}
