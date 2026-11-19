package desktopupdate

import (
	"context"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"time"
)

// secrets are the files without which an existing database must never be opened: a new key
// would make its sealed values unreadable.
var secrets = []string{"data-key", "admin-password"}

// databaseFolders hold a database inside the state folder: PGlite (the Node desktop) and the
// PostgreSQL 18 data folder of the Go desktop (ADR 0036).
var databaseFolders = []string{"pglite", "pg18"}

// firstStartFile is first-start.json.
type firstStartFile struct {
	Format        int     `json:"format"`
	Version       string  `json:"version"`
	StateDir      string  `json:"stateDir"`
	PreUpdateCopy *string `json:"preUpdateCopy"`
	At            string  `json:"at"`
}

// FirstStartOptions is the first start of a managed install.
type FirstStartOptions struct {
	Root    string
	Migrate Hook
	Now     func() time.Time
	Statfs  func(path string) (Disk, error)
}

// FirstStartResult reports whether the first start ran now and its pre-update copy, if any.
type FirstStartResult struct {
	Done          bool
	Version       string
	PreUpdateCopy string
}

func hasContent(path string) (bool, error) {
	data, err := os.ReadFile(path) //nolint:gosec // state-owned file
	if errors.Is(err, fs.ErrNotExist) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	return strings.TrimSpace(string(data)) != "", nil
}

// holdsDatabase reports whether the state folder already holds a database (older data).
func holdsDatabase(stateDir string) (bool, error) {
	for _, name := range databaseFolders {
		entries, err := os.ReadDir(filepath.Join(stateDir, name))
		if errors.Is(err, fs.ErrNotExist) || errors.Is(err, syscall.ENOTDIR) {
			continue
		}
		if err != nil {
			var pathErr *fs.PathError
			if errors.As(err, &pathErr) && !isDirectory(filepath.Join(stateDir, name)) {
				continue
			}
			return false, err
		}
		if len(entries) > 0 {
			return true, nil
		}
	}
	return false, nil
}

func isDirectory(path string) bool {
	info, err := os.Stat(path)
	return err == nil && info.IsDir()
}

// FirstStart is the first start of a managed install. A state folder that already holds a
// database is never migrated in place first: it is copied beside itself as
// <state>.pre-update-<UTC time>-first-start-<version> (kept, never deleted), the migration runs
// on a second copy <state>.rehearsal-<time>-<version>, and only then on the state folder; a
// failure there restores it from the dated copy. A failure on the rehearsal leaves the state
// folder untouched. Without its data key or admin password the database is refused before
// anything is written. Done once per install (first-start.json); later calls change nothing.
func FirstStart(ctx context.Context, o FirstStartOptions) (FirstStartResult, error) {
	root, err := filepath.Abs(o.Root)
	if err != nil {
		return FirstStartResult{}, err
	}
	if o.Now == nil {
		o.Now = time.Now
	}
	if o.Statfs == nil {
		o.Statfs = diskFree
	}
	held, err := acquireLock(root)
	if err != nil {
		return FirstStartResult{}, err
	}
	defer held.release()
	f := &firstStart{FirstStartOptions: o, ctx: ctx, root: root}
	result, runErr := f.run()
	if runErr == nil {
		return result, nil
	}
	return FirstStartResult{}, f.fail(runErr)
}

type firstStart struct {
	FirstStartOptions
	ctx       context.Context
	root      string
	version   string
	journal   *journal
	rehearsal string
}

func (f *firstStart) record(stateDir, preUpdateCopy string) (FirstStartResult, error) {
	marker := firstStartFile{Format: 1, Version: f.version, StateDir: stateDir, At: isoTime(f.Now())}
	var copyField any
	if preUpdateCopy != "" {
		marker.PreUpdateCopy = &preUpdateCopy
		copyField = preUpdateCopy
	}
	if err := writeJSONAtomic(filepath.Join(f.root, firstStartName), marker); err != nil {
		return FirstStartResult{}, err
	}
	fields := []field{{"event", "first-start"}, {"version", f.version}, {"preUpdateCopy", copyField}}
	if f.rehearsal != "" {
		fields = append(fields, field{"rehearsalCopy", f.rehearsal})
	}
	if err := logEvent(f.root, fields...); err != nil {
		return FirstStartResult{}, err
	}
	return FirstStartResult{Done: true, Version: f.version, PreUpdateCopy: preUpdateCopy}, nil
}

func (f *firstStart) run() (FirstStartResult, error) {
	if _, err := recoverLocked(f.root); err != nil {
		return FirstStartResult{}, err
	}
	current, err := ReadCurrent(f.root)
	if err != nil {
		return FirstStartResult{}, err
	}
	if current == nil {
		return FirstStartResult{}, newError(CodeCorrupt, "No installed version here")
	}
	f.version = current.Version
	var marker map[string]any
	if found, err := readJSON(filepath.Join(f.root, firstStartName), &marker); err != nil {
		return FirstStartResult{}, err
	} else if found && marker != nil {
		return FirstStartResult{Version: f.version}, nil
	}
	stateDir, err := stateDirOf(f.root)
	if err != nil {
		return FirstStartResult{}, err
	}
	if holds, err := holdsDatabase(stateDir); err != nil {
		return FirstStartResult{}, err
	} else if !holds {
		return f.record(stateDir, "")
	}
	for _, name := range secrets {
		ok, err := hasContent(filepath.Join(stateDir, name))
		if err != nil {
			return FirstStartResult{}, err
		}
		if !ok {
			return FirstStartResult{}, refuse("The state folder holds a database but %s is missing or empty; restore it from the backup of this state folder before starting SIPGES", filepath.Join(stateDir, name))
		}
	}
	if err := checkStateRoom(f.ctx, stateDir, 3, f.Statfs); err != nil {
		return FirstStartResult{}, err
	}
	when := stamp(f.Now())
	p := versionPath(f.version)
	if current.Adopted {
		p = current.Dir
	}
	preCopy, err := freeName(fmt.Sprintf("%s.pre-update-%s-first-start-%s", stateDir, when, f.version))
	if err != nil {
		return FirstStartResult{}, err
	}
	failedAside, err := freeName(fmt.Sprintf("%s.failed-%s-%s", stateDir, when, f.version))
	if err != nil {
		return FirstStartResult{}, err
	}
	f.journal = &journal{
		Kind:     "first-start",
		From:     journalFrom{Version: f.version, Path: p, Adopted: current.Adopted},
		To:       journalTo{Version: f.version, Path: p},
		StateDir: stateDir, PreCopy: preCopy, FailedAside: failedAside,
		Restoring: fmt.Sprintf("%s.restoring-%s-%s", stateDir, when, newUUID()),
		Phase:     "copying",
	}
	if err := saveJournal(f.root, *f.journal); err != nil {
		return FirstStartResult{}, err
	}
	if err := copyTree(stateDir, preCopy); err != nil {
		return FirstStartResult{}, err
	}
	if f.rehearsal, err = freeName(fmt.Sprintf("%s.rehearsal-%s-%s", stateDir, when, f.version)); err != nil {
		return FirstStartResult{}, err
	}
	if err := copyTree(stateDir, f.rehearsal); err != nil {
		return FirstStartResult{}, err
	}
	if err := f.Migrate(f.ctx, Target{VersionDir: current.Dir, StateDir: f.rehearsal, Version: f.version}); err != nil {
		// Only copies were handed to the migration: nothing to undo.
		if removeErr := removeJournal(f.root); removeErr != nil {
			return FirstStartResult{}, removeErr
		}
		f.journal = nil
		return FirstStartResult{}, newError(CodeRolledBack, "The first start of %s failed on a copy of the state folder; the state folder was not touched: %s", f.version, err.Error())
	}
	f.journal.Phase = "migrating"
	if err := saveJournal(f.root, *f.journal); err != nil {
		return FirstStartResult{}, err
	}
	if err := f.Migrate(f.ctx, Target{VersionDir: current.Dir, StateDir: stateDir, Version: f.version}); err != nil {
		return FirstStartResult{}, err
	}
	if err := removeJournal(f.root); err != nil {
		return FirstStartResult{}, err
	}
	f.journal = nil
	return f.record(stateDir, preCopy)
}

func (f *firstStart) fail(err error) error {
	if f.journal != nil {
		if undoErr := undo(f.root, *f.journal); undoErr != nil {
			_ = logEvent(f.root, field{"event", "rollback-incomplete"}, field{"from", f.version}, field{"to", f.version},
				field{"step", "first-start"}, field{"reason", err.Error()}, field{"error", undoErr.Error()})
			return rollbackIncomplete(fmt.Sprintf("The first start of %s failed and the state folder could not be restored (%s)", f.version, undoErr.Error()), f.journal.PreCopy)
		}
		if stateAtRisk[f.journal.Phase] {
			err = newError(CodeRolledBack, "The first start of %s failed and the state folder was restored from %s: %s", f.version, f.journal.PreCopy, err.Error())
		} else {
			err = newError(CodeRolledBack, "The first start of %s failed before any migration; the state folder was not touched: %s", f.version, err.Error())
		}
	}
	if f.version != "" {
		_ = logEvent(f.root, field{"event", "first-start-failed"}, field{"version", f.version}, field{"code", errCode(err)}, field{"reason", err.Error()})
	}
	return err
}
