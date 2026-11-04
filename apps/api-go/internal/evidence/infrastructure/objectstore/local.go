package objectstore

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"sync"

	"github.com/Dreamcoder08/sipges/apps/api-go/internal/evidence/domain"
)

// Local stores objects as files under a root directory (local-object-storage.ts: development
// and single-server installs on a persistent disk). Writes go to a temporary file renamed into
// place, so a crash never leaves a truncated object under the final key.
type Local struct {
	root string
}

// NewLocal resolves root against the working directory, as path.resolve does.
func NewLocal(root string) (*Local, error) {
	abs, err := filepath.Abs(root)
	if err != nil {
		return nil, err
	}
	return &Local{root: abs}, nil
}

// pathFor refuses any key outside the generated layout or the root: keys are opaque and made
// by the service, so anything else is a bug or a tampered row.
func (l *Local) pathFor(key string) (string, error) {
	if !domain.ValidObjectKey(key) {
		return "", fmt.Errorf("invalid object key: %s", key)
	}
	path := filepath.Join(l.root, key)
	if !strings.HasPrefix(path, l.root+string(filepath.Separator)) {
		return "", fmt.Errorf("object key escapes storage root: %s", key)
	}
	return path, nil
}

// Put writes data under key.
func (l *Local) Put(_ context.Context, key string, data []byte, _ string) error {
	path, err := l.pathFor(key)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o750); err != nil {
		return err
	}
	var suffix [6]byte
	if _, err := rand.Read(suffix[:]); err != nil {
		return err
	}
	temporary := path + "." + hex.EncodeToString(suffix[:]) + ".tmp"
	f, err := os.OpenFile(temporary, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600) //nolint:gosec // path checked by pathFor
	if err != nil {
		return err
	}
	_, werr := f.Write(data)
	cerr := f.Close()
	if err := errors.Join(werr, cerr); err != nil {
		_ = os.Remove(temporary)
		return err
	}
	return os.Rename(temporary, path)
}

// Get reads the object; found=false when the file does not exist.
func (l *Local) Get(_ context.Context, key string) ([]byte, bool, error) {
	path, err := l.pathFor(key)
	if err != nil {
		return nil, false, err
	}
	data, err := os.ReadFile(path) //nolint:gosec // path checked by pathFor
	if errors.Is(err, fs.ErrNotExist) {
		return nil, false, nil
	}
	if err != nil {
		return nil, false, err
	}
	return data, true, nil
}

// Delete removes the object; a missing one is not an error.
func (l *Local) Delete(_ context.Context, key string) error {
	path, err := l.pathFor(key)
	if err != nil {
		return err
	}
	if err := os.Remove(path); err != nil && !errors.Is(err, fs.ErrNotExist) {
		return err
	}
	return nil
}

// Memory keeps objects in memory: the fake for tests (no network, no disk).
type Memory struct {
	mu      sync.Mutex
	objects map[string][]byte
	types   map[string]string
}

// NewMemory returns an empty in-memory store.
func NewMemory() *Memory {
	return &Memory{objects: map[string][]byte{}, types: map[string]string{}}
}

// Put stores a copy of data.
func (m *Memory) Put(_ context.Context, key string, data []byte, contentType string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.objects[key] = append([]byte(nil), data...)
	m.types[key] = contentType
	return nil
}

// Get returns a copy of the object.
func (m *Memory) Get(_ context.Context, key string) ([]byte, bool, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	data, ok := m.objects[key]
	return append([]byte(nil), data...), ok, nil
}

// Delete removes the object.
func (m *Memory) Delete(_ context.Context, key string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	delete(m.objects, key)
	delete(m.types, key)
	return nil
}

// Keys lists the stored keys (tests).
func (m *Memory) Keys() []string {
	m.mu.Lock()
	defer m.mu.Unlock()
	keys := make([]string, 0, len(m.objects))
	for k := range m.objects {
		keys = append(keys, k)
	}
	return keys
}

// ContentType is the content type an object was stored with (tests).
func (m *Memory) ContentType(key string) string {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.types[key]
}
