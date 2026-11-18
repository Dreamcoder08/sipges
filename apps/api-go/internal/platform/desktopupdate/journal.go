package desktopupdate

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
)

// journal is update-journal.json, in the Node updater's key order. Kind is "first-start" for
// the journal of a first start and empty for an update.
type journal struct {
	Kind        string      `json:"kind,omitempty"`
	From        journalFrom `json:"from"`
	To          journalTo   `json:"to"`
	StateDir    string      `json:"stateDir"`
	PreCopy     string      `json:"preCopy"`
	FailedAside string      `json:"failedAside"`
	Restoring   string      `json:"restoring"`
	Phase       string      `json:"phase"`
}

type journalFrom struct {
	Version string `json:"version"`
	Path    string `json:"path"`
	Adopted bool   `json:"adopted"`
}

type journalTo struct {
	Version string `json:"version"`
	Path    string `json:"path"`
}

// stateAtRisk are the journal phases in which the migration may already have changed the state.
var stateAtRisk = map[string]bool{"migrating": true, "switched": true, "restoring": true}

func saveJournal(root string, j journal) error {
	return writeJSONAtomic(filepath.Join(root, journalName), j)
}

func removeJournal(root string) error {
	err := os.Remove(filepath.Join(root, journalName))
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	return nil
}

func present(path string) bool {
	ok, err := pathExists(path)
	return ok || err != nil // an unreadable entry is never treated as absent
}

// checkRestored: with the changed state already moved aside, a folder at the state's name is
// either the restored copy or one created since (an installer rerun, by hand). Only the restored
// copy may end the journal: it is proven when no restore copy waits any more and it matches the
// pre-update copy it was made from. Otherwise nothing is moved, copied or deleted.
func checkRestored(j journal) error {
	halt := func(problem string) error {
		return newError(CodeRollbackIncomplete, "the state folder %s %s", j.StateDir, problem)
	}
	if present(j.Restoring) {
		return halt(fmt.Sprintf("was created again while its restore was pending; the restored data is still in %s: move %s aside without deleting anything, then run --recover again", j.Restoring, j.StateDir))
	}
	if !present(j.PreCopy) {
		return halt(fmt.Sprintf("cannot be proven restored: the pre-update copy %s is missing", j.PreCopy))
	}
	live, err := treeShape(j.StateDir)
	if err != nil {
		return err
	}
	pre, err := treeShape(j.PreCopy)
	if err != nil {
		return err
	}
	if live != pre {
		return halt(fmt.Sprintf("cannot be proven restored: it does not match the pre-update copy %s", j.PreCopy))
	}
	return nil
}

// restoreState is idempotent: it moves the changed state aside (never deleted) and puts a fresh
// copy of the pre-update copy in its place.
func restoreState(root string, j journal) error {
	if present(j.StateDir) && present(j.FailedAside) {
		return checkRestored(j)
	}
	// The restore copy is only replaced by a new copy of the pre-update one: without it, it is kept.
	if present(j.StateDir) && !present(j.PreCopy) {
		return newError(CodeRollbackIncomplete, "the pre-update copy %s is missing; nothing was moved or deleted", j.PreCopy)
	}
	j.Phase = "restoring"
	if err := saveJournal(root, j); err != nil {
		return err
	}
	if present(j.StateDir) && !present(j.FailedAside) {
		if err := os.RemoveAll(j.Restoring); err != nil {
			return err
		}
		if err := copyDir(j.PreCopy, j.Restoring); err != nil {
			return err
		}
		if err := RenameRetry(j.StateDir, j.FailedAside); err != nil {
			return err
		}
	}
	if !present(j.StateDir) {
		return RenameRetry(j.Restoring, j.StateDir)
	}
	return nil
}

// undo makes the previous version current again and restores the state if it may have changed.
func undo(root string, j journal) error {
	current, err := ReadCurrent(root)
	if err != nil {
		return err
	}
	if current == nil || current.Version != j.From.Version {
		if err := writePointer(root, j.From.Version, j.From.Path, j.From.Adopted); err != nil {
			return err
		}
	}
	if stateAtRisk[j.Phase] {
		if err := restoreState(root, j); err != nil {
			return err
		}
	}
	return removeJournal(root)
}

func rollbackIncomplete(message, preCopy string) *Error {
	return &Error{
		Code:          CodeRollbackIncomplete,
		Message:       message + ". Do not start SIPGES on this state folder: run --recover to retry, or restore it from the pre-update copy: " + preCopy,
		PreUpdateCopy: preCopy,
	}
}

func readJournal(root string) (*journal, error) {
	var j *journal
	found, err := readJSON(filepath.Join(root, journalName), &j)
	// A journal of null is no journal, as for the Node updater.
	if err != nil || !found || j == nil {
		return nil, err
	}
	// Recovery rewrites current.json from it: without a version to go back to and an absolute state
	// folder it would write an empty pointer, so such a journal is corrupt and is left as it is.
	if !isVersion(j.From.Version) || !filepath.IsAbs(j.StateDir) {
		return nil, newError(CodeCorrupt, "%s is invalid", journalName)
	}
	return j, nil
}

func recoverLocked(root string) (bool, error) {
	j, err := readJournal(root)
	if err != nil || j == nil {
		return false, err
	}
	if err := undo(root, *j); err != nil {
		_ = logEvent(root, field{"event", "rollback-incomplete"}, field{"from", j.To.Version}, field{"to", j.From.Version},
			field{"phase", j.Phase}, field{"error", err.Error()})
		return false, rollbackIncomplete(fmt.Sprintf("An interrupted update to %s could not be rolled back (%s)", j.To.Version, err.Error()), j.PreCopy)
	}
	return true, logEvent(root, field{"event", "recovered"}, field{"from", j.To.Version}, field{"to", j.From.Version}, field{"phase", j.Phase})
}

// RecoverResult is the current version after Recover, and whether an update was rolled back.
type RecoverResult struct {
	Current   *Current
	Recovered bool
}

// Recover rolls back an interrupted update (or first start) left by a crash, under the lock.
func Recover(_ context.Context, root string) (RecoverResult, error) {
	root, err := filepath.Abs(root)
	if err != nil {
		return RecoverResult{}, err
	}
	held, err := acquireLock(root)
	if err != nil {
		return RecoverResult{}, err
	}
	defer held.release()
	recovered, err := recoverLocked(root)
	if err != nil {
		return RecoverResult{}, err
	}
	current, err := ReadCurrent(root)
	return RecoverResult{Current: current, Recovered: recovered}, err
}

// AcceptResult is the current version after AcceptRestoredState, and whether a journal was cleared.
type AcceptResult struct {
	Current  *Current
	Accepted bool
}

// AcceptRestoredState is the way out of a halted update (ROLLBACK_INCOMPLETE) after the person
// put their own backup back in the state folder: the version from before the update becomes
// current again and the pending journal is cleared. Nothing in or beside the state folder is
// copied, moved or deleted. Refused while the state folder is missing, empty or not a folder.
func AcceptRestoredState(_ context.Context, root string) (AcceptResult, error) {
	root, err := filepath.Abs(root)
	if err != nil {
		return AcceptResult{}, err
	}
	held, err := acquireLock(root)
	if err != nil {
		return AcceptResult{}, err
	}
	defer held.release()
	j, err := readJournal(root)
	if err != nil {
		return AcceptResult{}, err
	}
	if j == nil {
		current, err := ReadCurrent(root)
		return AcceptResult{Current: current}, err
	}
	restoreFirst := func(problem string) error {
		return refuse("The state folder %s %s: restore your backup there first", j.StateDir, problem)
	}
	info, err := os.Lstat(j.StateDir)
	if errors.Is(err, os.ErrNotExist) {
		return AcceptResult{}, restoreFirst("does not exist")
	}
	if err != nil {
		return AcceptResult{}, err
	}
	if isLink(info.Mode()) || !info.IsDir() {
		return AcceptResult{}, restoreFirst("is not a folder")
	}
	entries, err := os.ReadDir(j.StateDir)
	if err != nil {
		return AcceptResult{}, err
	}
	if len(entries) == 0 {
		return AcceptResult{}, restoreFirst("is empty")
	}
	if current, err := ReadCurrent(root); err != nil || current == nil || current.Version != j.From.Version {
		if err := writePointer(root, j.From.Version, j.From.Path, j.From.Adopted); err != nil {
			return AcceptResult{}, err
		}
	}
	if err := removeJournal(root); err != nil {
		return AcceptResult{}, err
	}
	if err := logEvent(root, field{"event", "restored-state-accepted"}, field{"from", j.To.Version}, field{"to", j.From.Version},
		field{"phase", j.Phase}, field{"stateDir", j.StateDir}); err != nil {
		return AcceptResult{}, err
	}
	current, err := ReadCurrent(root)
	return AcceptResult{Current: current, Accepted: true}, err
}
