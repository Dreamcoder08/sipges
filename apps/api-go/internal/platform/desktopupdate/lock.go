package desktopupdate

import (
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"math"
	"os"
	"path/filepath"
	"sync"
	"time"
)

// A running update rewrites its lock every lockHeartbeat; a lock not rewritten for lockStale is
// left by a process that is gone, even when its pid now belongs to another program. The format
// is the Node updater's, so Node and Go never hold the lock at once.
var (
	lockHeartbeat = 10 * time.Second
	lockStale     = 120 * time.Second
)

// lockBody is update.lock format 2, written compact as JSON.stringify does.
type lockBody struct {
	Format    int    `json:"format"`
	Pid       int    `json:"pid"`
	Token     string `json:"token"`
	Heartbeat string `json:"heartbeat"`
}

type foundLock struct {
	text  string
	held  map[string]any // nil when the content is not a JSON object
	valid bool           // the content parsed as JSON at all
	mtime time.Time
}

func readLock(path string) (*foundLock, error) {
	data, err := os.ReadFile(path) //nolint:gosec // install-owned
	if errors.Is(err, fs.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	info, err := os.Lstat(path)
	if errors.Is(err, fs.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	found := &foundLock{text: string(data), mtime: info.ModTime()}
	var value any
	if json.Unmarshal(data, &value) == nil {
		found.valid = value != nil
		found.held, _ = value.(map[string]any)
	}
	return found, nil
}

// pidOf is the lock's pid when it is a whole number, as Number.isInteger checks.
func pidOf(held map[string]any) (int, bool) {
	n, ok := held["pid"].(float64)
	if !ok || n != math.Trunc(n) || math.IsInf(n, 0) {
		return 0, false
	}
	return int(n), true
}

// stale reports a lock whose heartbeat (or, for an unreadable one, its file time) is older than
// lockStale, whatever its pid, or whose process is gone.
func (l *foundLock) stale() bool {
	last := l.mtime
	for _, key := range []string{"heartbeat", "time"} {
		value, present := l.held[key]
		if !present || value == nil {
			continue
		}
		if text, ok := value.(string); ok {
			if t, err := time.Parse(time.RFC3339Nano, text); err == nil {
				last = t
			}
		}
		break
	}
	if time.Since(last) > lockStale {
		return true
	}
	pid, ok := pidOf(l.held)
	return l.valid && ok && !alive(pid)
}

// takeOver removes a stale lock. Only one process at a time may do it: the takeover is guarded
// by an exclusively created directory, so two racers can never move each other's fresh lock
// aside. Inside the guard the lock is read again and removed only if it is still the stale one
// found. A guard left by a crash is cleared once it is older than lockStale.
func takeOver(path string, found *foundLock) error {
	guard := path + ".takeover"
	if err := os.Mkdir(guard, 0o700); err != nil {
		if !errors.Is(err, fs.ErrExist) {
			return err
		}
		if info, statErr := os.Lstat(guard); statErr == nil && time.Since(info.ModTime()) > lockStale {
			_ = os.RemoveAll(guard)
		}
		return newError(CodeBusy, "Another update is taking over the lock")
	}
	defer func() { _ = os.RemoveAll(guard) }()
	current, err := readLock(path)
	if err != nil {
		return err
	}
	if current == nil || current.text != found.text {
		return nil
	}
	aside := path + ".stale-" + newUUID()
	if err := RenameRetry(path, aside); err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return nil
		}
		return err
	}
	return os.Remove(aside)
}

// heldLock is this run's lock; release stops the heartbeat and removes the lock while it still
// carries this run's token.
type heldLock struct {
	path  string
	token string
	stop  chan struct{}
	done  sync.WaitGroup
	once  sync.Once
}

func lockText(token string) ([]byte, error) {
	return marshal(lockBody{Format: 2, Pid: os.Getpid(), Token: token, Heartbeat: isoTime(time.Now())}, false)
}

// acquireLock creates update.lock complete or not at all: the full content is written to a temp
// file and hard-linked to the lock name, which fails when the name exists.
func acquireLock(root string) (*heldLock, error) {
	path := filepath.Join(root, lockName)
	token := newUUID()
	for attempt := 0; attempt < 3; attempt++ {
		body, err := lockText(token)
		if err != nil {
			return nil, err
		}
		temporary := path + "." + token + ".tmp"
		if err := writeFileNew(temporary, body, false); err != nil {
			return nil, err
		}
		linkErr := os.Link(temporary, path)
		if err := os.Remove(temporary); err != nil && !errors.Is(err, fs.ErrNotExist) {
			return nil, err
		}
		if linkErr == nil {
			return holdLock(path, token), nil
		}
		if !errors.Is(linkErr, fs.ErrExist) {
			return nil, linkErr
		}
		found, err := readLock(path)
		if err != nil {
			return nil, err
		}
		if found == nil {
			continue
		}
		if !found.stale() {
			if pid, ok := pidOf(found.held); ok {
				return nil, newError(CodeBusy, "Another update is running (process %d)", pid)
			}
			return nil, newError(CodeBusy, "Another update is starting")
		}
		// A crashed update: the journal decides what to undo.
		if err := takeOver(path, found); err != nil {
			return nil, err
		}
	}
	return nil, newError(CodeBusy, "Could not take the update lock")
}

func holdLock(path, token string) *heldLock {
	held := &heldLock{path: path, token: token, stop: make(chan struct{})}
	held.done.Add(1)
	go func() {
		defer held.done.Done()
		ticker := time.NewTicker(lockHeartbeat)
		defer ticker.Stop()
		for {
			select {
			case <-held.stop:
				return
			case <-ticker.C:
				if !held.beat() {
					return
				}
			}
		}
	}()
	return held
}

// beat rewrites the lock with a fresh heartbeat; false once the lock is no longer this run's.
func (h *heldLock) beat() bool {
	current, err := readLock(h.path)
	if err != nil {
		return true
	}
	if current == nil || current.held["token"] != h.token {
		return false
	}
	body, err := lockText(h.token)
	if err != nil {
		return true
	}
	temporary := fmt.Sprintf("%s.%s.tmp", h.path, newUUID())
	if err := writeFileNew(temporary, body, false); err != nil {
		return true
	}
	if err := RenameRetry(temporary, h.path); err != nil {
		_ = os.Remove(temporary)
	}
	return true
}

func (h *heldLock) release() {
	h.once.Do(func() {
		close(h.stop)
		h.done.Wait()
		if current, err := readLock(h.path); err == nil && current != nil && current.held["token"] == h.token {
			_ = os.Remove(h.path)
		}
	})
}
