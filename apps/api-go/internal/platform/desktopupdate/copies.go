package desktopupdate

import (
	"context"
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"time"
)

// The copies the updater leaves beside the state folder, named <state>.<kind>-<UTC time>-….
// None is ever deleted automatically: they hold the data and its key.
var copyKinds = []string{"pre-update", "rehearsal", "failed"}

// StateCopy is one copy beside the state folder.
type StateCopy struct {
	Kind  string
	Path  string
	At    time.Time
	Bytes int64
}

// CopyList is every copy beside the recorded state folder, oldest first.
type CopyList struct {
	StateDir        string
	Copies          []StateCopy
	Count           int
	Bytes           int64
	NewestPreUpdate string
}

// ListStateCopies lists the finished copies the updater named beside the state folder (not
// .partial copies, links, files or other folders), oldest first.
func ListStateCopies(root string) (CopyList, error) {
	root, err := filepath.Abs(root)
	if err != nil {
		return CopyList{}, err
	}
	stateDir, err := stateDirOf(root)
	if err != nil {
		return CopyList{}, err
	}
	pattern := regexp.MustCompile(`^` + regexp.QuoteMeta(filepath.Base(stateDir)) + `\.(` + strings.Join(copyKinds, "|") + `)-(\d{8}T\d{6}Z)(-.*)?$`)
	entries, err := os.ReadDir(filepath.Dir(stateDir))
	if err != nil && !errors.Is(err, fs.ErrNotExist) {
		return CopyList{}, err
	}
	list := CopyList{StateDir: stateDir, Copies: []StateCopy{}}
	for _, entry := range entries {
		match := pattern.FindStringSubmatch(entry.Name())
		if match == nil || strings.HasSuffix(entry.Name(), ".partial") || !entry.IsDir() {
			continue
		}
		at, err := time.Parse("20060102T150405Z", match[2])
		if err != nil {
			continue
		}
		path := filepath.Join(filepath.Dir(stateDir), entry.Name())
		bytes, err := treeBytes(path)
		if err != nil {
			return CopyList{}, err
		}
		list.Copies = append(list.Copies, StateCopy{Kind: match[1], Path: path, At: at, Bytes: bytes})
	}
	sort.SliceStable(list.Copies, func(i, j int) bool {
		a, b := list.Copies[i], list.Copies[j]
		if !a.At.Equal(b.At) {
			return a.At.Before(b.At)
		}
		return a.Path < b.Path
	})
	for _, c := range list.Copies {
		list.Count++
		list.Bytes += c.Bytes
		if c.Kind == "pre-update" {
			list.NewestPreUpdate = c.Path
		}
	}
	return list, nil
}

// RemoveOptions is the explicit clean-up of old copies.
type RemoveOptions struct {
	Root          string
	OlderThanDays int
	Now           time.Time
}

// RemoveResult lists the copies removed, the old pre-update copy kept, and how many are left.
type RemoveResult struct {
	Removed []StateCopy
	Kept    string
	Left    int
}

// RemoveStateCopies removes the copies whose name is older than OlderThanDays whole days, except
// the newest pre-update copy, which is never removed (it is the way back from the last update).
// Refused while an update or first start is pending or halted, since its journal may need any.
func RemoveStateCopies(_ context.Context, o RemoveOptions) (RemoveResult, error) {
	root, err := filepath.Abs(o.Root)
	if err != nil {
		return RemoveResult{}, err
	}
	if o.OlderThanDays < 1 {
		return RemoveResult{}, refuse("The age of the copies to remove must be a whole number of days, 1 or more")
	}
	held, err := acquireLock(root)
	if err != nil {
		return RemoveResult{}, err
	}
	defer held.release()
	if present(filepath.Join(root, journalName)) {
		return RemoveResult{}, refuse("An update is pending or halted; its copies may be needed. Run --recover first (or restore the state folder and --accept-restored-state), then remove copies.")
	}
	listed, err := ListStateCopies(root)
	if err != nil {
		return RemoveResult{}, err
	}
	now := o.Now
	if now.IsZero() {
		now = time.Now()
	}
	limit := now.Add(-time.Duration(o.OlderThanDays) * 24 * time.Hour)
	result := RemoveResult{Removed: []StateCopy{}}
	for _, c := range listed.Copies {
		if !c.At.Before(limit) {
			continue
		}
		if c.Path == listed.NewestPreUpdate {
			result.Kept = c.Path
			continue
		}
		result.Removed = append(result.Removed, c)
	}
	for _, c := range result.Removed {
		if err := os.RemoveAll(c.Path); err != nil {
			return RemoveResult{}, err
		}
	}
	result.Left = listed.Count - len(result.Removed)
	if len(result.Removed) > 0 || result.Kept != "" {
		removed := make([]string, 0, len(result.Removed))
		for _, c := range result.Removed {
			removed = append(removed, c.Path)
		}
		var kept any
		if result.Kept != "" {
			kept = result.Kept
		}
		if err := logEvent(root, field{"event", "copies-removed"}, field{"olderThanDays", o.OlderThanDays},
			field{"removed", removed}, field{"kept", kept}); err != nil {
			return RemoveResult{}, err
		}
	}
	return result, nil
}
