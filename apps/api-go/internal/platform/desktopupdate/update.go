package desktopupdate

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"time"
)

// InstallOptions is a first install of a verified release; the trust key comes from the operator.
type InstallOptions struct {
	Root     string
	Release  string
	StateDir string
	TrustKey []byte
	Verifier Verifier
}

// InstallResult is the version installed.
type InstallResult struct{ Version string }

// verify asks the verifier and reports its refusals as REFUSED with their message.
func verify(ctx context.Context, verifier Verifier, req VerifyRequest) (Release, error) {
	release, err := verifier.Verify(ctx, req)
	if err != nil {
		var e *Error
		if errors.Is(err, ErrRefused) && !errors.As(err, &e) {
			return Release{}, &Error{Code: CodeRefused, Message: err.Error()}
		}
		return Release{}, err
	}
	return release, nil
}

// Install is the first install of a release into an empty install root.
func Install(ctx context.Context, o InstallOptions) (InstallResult, error) {
	root, err := filepath.Abs(o.Root)
	if err != nil {
		return InstallResult{}, err
	}
	releaseDir, err := filepath.Abs(o.Release)
	if err != nil {
		return InstallResult{}, err
	}
	if err := refuseLinkedState(o.StateDir); err != nil {
		return InstallResult{}, err
	}
	if err := os.MkdirAll(root, 0o700); err != nil {
		return InstallResult{}, err
	}
	held, err := acquireLock(root)
	if err != nil {
		return InstallResult{}, err
	}
	defer held.release()
	if current, err := ReadCurrent(root); err != nil {
		return InstallResult{}, err
	} else if current != nil {
		return InstallResult{}, refuse("A version is already installed; use update")
	}
	if o.TrustKey == nil {
		return InstallResult{}, refuse("The first install needs --trust-key")
	}
	if err := checkStateDir(root, o.StateDir); err != nil {
		return InstallResult{}, err
	}
	stateDir, err := canonicalState(o.StateDir)
	if err != nil {
		return InstallResult{}, err
	}
	if err := checkStateDir(root, stateDir); err != nil {
		return InstallResult{}, err
	}
	release, err := verify(ctx, o.Verifier, VerifyRequest{ReleaseDir: releaseDir, TrustKey: o.TrustKey})
	if err != nil {
		return InstallResult{}, err
	}
	s, err := stage(root, release)
	if err != nil {
		return InstallResult{}, err
	}
	if err := commitStaging(s, time.Now()); err != nil {
		return InstallResult{}, err
	}
	if err := recordStateDir(root, stateDir); err != nil {
		return InstallResult{}, err
	}
	if err := writePointer(root, release.Version, versionPath(release.Version), false); err != nil {
		return InstallResult{}, err
	}
	return InstallResult{Version: release.Version}, logEvent(root, field{"event", "installed"}, field{"to", release.Version})
}

// Adoption takes over an old plain package (no versions/) and its state folder.
type Adoption struct {
	Dir      string
	StateDir string
}

// UpdateOptions verifies a local release and switches to it. Migrate and Ready receive the new
// version and the state folder; OnStep sees each of Steps; Now and Statfs are for tests.
type UpdateOptions struct {
	Root          string
	Release       string
	Verifier      Verifier
	Migrate       Hook
	Ready         Hook
	TrustKey      []byte
	Adopt         *Adoption
	OnStep        func(step string) error
	Now           func() time.Time
	ExpectVersion string
	Statfs        func(path string) (Disk, error)
}

// UpdateResult is a committed update.
type UpdateResult struct {
	From          string
	To            string
	PreUpdateCopy string
}

type adoption struct {
	current  Current
	stateDir string
}

// checkAdoption checks an old plain package; nothing is recorded until its release verified.
func checkAdoption(root string, a Adoption) (adoption, error) {
	dir, err := filepath.Abs(a.Dir)
	if err != nil {
		return adoption{}, err
	}
	version := metadataVersion(dir)
	if !isVersion(version) || !present(filepath.Join(dir, entryName)) {
		return adoption{}, refuse("%s is not a desktop package (metadata.json and start.mjs)", dir)
	}
	if inside(filepath.Join(root, versionsDir), dir) {
		return adoption{}, refuse("The old install must be outside versions/")
	}
	if err := checkStateDir(root, a.StateDir); err != nil {
		return adoption{}, err
	}
	if ok, err := pathExists(a.StateDir); err != nil {
		return adoption{}, err
	} else if !ok {
		return adoption{}, refuse("The state folder does not exist: %s", a.StateDir)
	}
	stateDir, err := canonicalState(a.StateDir)
	if err != nil {
		return adoption{}, err
	}
	if err := checkStateDir(root, stateDir); err != nil {
		return adoption{}, err
	}
	var existing installFile
	if found, err := readJSON(filepath.Join(root, installName), &existing); err != nil {
		return adoption{}, err
	} else if found && existing.StateDir != stateDir {
		return adoption{}, refuse("This install already uses the state folder %s", existing.StateDir)
	}
	return adoption{current: Current{Version: version, Dir: dir, Adopted: true}, stateDir: stateDir}, nil
}

// Update verifies a release, stages it, copies the state, rehearses (adopted installs), migrates,
// switches and checks readiness; every failure after the state copy is undone from the journal.
func Update(ctx context.Context, o UpdateOptions) (UpdateResult, error) {
	root, err := filepath.Abs(o.Root)
	if err != nil {
		return UpdateResult{}, err
	}
	releaseDir, err := filepath.Abs(o.Release)
	if err != nil {
		return UpdateResult{}, err
	}
	if o.Now == nil {
		o.Now = time.Now
	}
	if o.Statfs == nil {
		o.Statfs = diskFree
	}
	if o.Adopt != nil {
		if err := os.MkdirAll(root, 0o700); err != nil {
			return UpdateResult{}, err
		}
	} else if !present(filepath.Join(root, pointerName)) {
		return UpdateResult{}, refuse("No installed version here: install one first or adopt an old one")
	}
	held, err := acquireLock(root)
	if err != nil {
		return UpdateResult{}, err
	}
	defer held.release()
	t := &transaction{UpdateOptions: o, ctx: ctx, root: root, releaseDir: releaseDir, at: "recover"}
	result, runErr := t.run()
	if runErr == nil {
		return result, nil
	}
	return UpdateResult{}, t.fail(runErr)
}

type transaction struct {
	UpdateOptions
	ctx        context.Context
	root       string
	releaseDir string
	at         string
	journal    *journal
	rehearsal  bool
}

func (t *transaction) step(name string) error {
	if t.OnStep == nil {
		return nil
	}
	return t.OnStep(name)
}

func (t *transaction) save(phase string) error {
	t.journal.Phase = phase
	return saveJournal(t.root, *t.journal)
}

func (t *transaction) run() (UpdateResult, error) {
	if err := t.step("locked"); err != nil {
		return UpdateResult{}, err
	}
	if _, err := recoverLocked(t.root); err != nil {
		return UpdateResult{}, err
	}
	t.at = "verify"
	current, err := ReadCurrent(t.root)
	if err != nil {
		return UpdateResult{}, err
	}
	var stateDir string
	var adopted *adoption
	if t.Adopt != nil {
		if current != nil {
			return UpdateResult{}, refuse("This install already has a current version; adopt only once")
		}
		a, err := checkAdoption(t.root, *t.Adopt)
		if err != nil {
			return UpdateResult{}, err
		}
		adopted, current, stateDir = &a, &a.current, a.stateDir
	} else if stateDir, err = stateDirOf(t.root); err != nil {
		return UpdateResult{}, err
	}
	release, err := verify(t.ctx, t.Verifier, VerifyRequest{
		ReleaseDir: t.releaseDir, TrustKey: t.TrustKey,
		Installed: &Installed{Version: current.Version, Dir: current.Dir, Adopted: current.Adopted},
	})
	if err != nil {
		return UpdateResult{}, err
	}
	if t.ExpectVersion != "" && release.Version != t.ExpectVersion {
		return UpdateResult{}, refuse("The release holds %s, not the requested %s", release.Version, t.ExpectVersion)
	}
	copies := uint64(2)
	if current.Adopted {
		copies = 3
	}
	if err := checkStateRoom(stateDir, copies, t.Statfs); err != nil {
		return UpdateResult{}, err
	}
	if err := t.step("verified"); err != nil {
		return UpdateResult{}, err
	}
	t.at = "stage"
	s, err := stage(t.root, release)
	if err != nil {
		return UpdateResult{}, err
	}
	if adopted != nil {
		if err := recordStateDir(t.root, adopted.stateDir); err != nil {
			return UpdateResult{}, err
		}
		if err := writePointer(t.root, adopted.current.Version, adopted.current.Dir, true); err != nil {
			return UpdateResult{}, err
		}
		if err := logEvent(t.root, field{"event", "adopted"}, field{"to", adopted.current.Version}, field{"dir", adopted.current.Dir}); err != nil {
			return UpdateResult{}, err
		}
	}
	if err := t.step("staged"); err != nil {
		return UpdateResult{}, err
	}
	date := t.Now()
	if err := commitStaging(s, date); err != nil {
		return UpdateResult{}, err
	}
	if err := t.step("installed"); err != nil {
		return UpdateResult{}, err
	}
	return t.migrate(current, release.Version, stateDir, s.final, stamp(date))
}

func (t *transaction) migrate(current *Current, to, stateDir, versionDir, when string) (UpdateResult, error) {
	from := current.Version
	t.at = "state copy"
	fromPath := versionPath(from)
	if current.Adopted {
		fromPath = current.Dir
	}
	preCopy, err := freeName(fmt.Sprintf("%s.pre-update-%s-%s-to-%s", stateDir, when, from, to))
	if err != nil {
		return UpdateResult{}, err
	}
	failedAside, err := freeName(fmt.Sprintf("%s.failed-%s-%s", stateDir, when, to))
	if err != nil {
		return UpdateResult{}, err
	}
	t.journal = &journal{
		From:     journalFrom{Version: from, Path: fromPath, Adopted: current.Adopted},
		To:       journalTo{Version: to, Path: versionPath(to)},
		StateDir: stateDir, PreCopy: preCopy, FailedAside: failedAside,
		Restoring: fmt.Sprintf("%s.restoring-%s-%s", stateDir, when, newUUID()),
	}
	if err := t.save("copying"); err != nil {
		return UpdateResult{}, err
	}
	if err := copyTree(stateDir, preCopy); err != nil {
		return UpdateResult{}, err
	}
	if err := t.step("state-copied"); err != nil {
		return UpdateResult{}, err
	}
	rehearsal := ""
	if current.Adopted {
		t.at = "rehearsal"
		if rehearsal, err = freeName(fmt.Sprintf("%s.rehearsal-%s-%s", stateDir, when, to)); err != nil {
			return UpdateResult{}, err
		}
		if err := copyTree(stateDir, rehearsal); err != nil {
			return UpdateResult{}, err
		}
		target := Target{VersionDir: versionDir, StateDir: rehearsal, Version: to}
		if err := t.Migrate(t.ctx, target); err != nil {
			t.rehearsal = true
			return UpdateResult{}, err
		}
		if err := t.Ready(t.ctx, target); err != nil {
			t.rehearsal = true
			return UpdateResult{}, err
		}
		if err := t.step("rehearsed"); err != nil {
			return UpdateResult{}, err
		}
	}
	t.at = "migrate"
	if err := t.save("migrating"); err != nil {
		return UpdateResult{}, err
	}
	if err := t.Migrate(t.ctx, Target{VersionDir: versionDir, StateDir: stateDir, Version: to}); err != nil {
		return UpdateResult{}, err
	}
	if err := t.step("migrated"); err != nil {
		return UpdateResult{}, err
	}
	t.at = "switch"
	if err := t.save("switched"); err != nil {
		return UpdateResult{}, err
	}
	if err := writePointer(t.root, to, t.journal.To.Path, false); err != nil {
		return UpdateResult{}, err
	}
	if err := t.step("switched"); err != nil {
		return UpdateResult{}, err
	}
	t.at = "ready"
	live, err := ReadCurrent(t.root)
	if err != nil {
		return UpdateResult{}, err
	}
	if err := t.Ready(t.ctx, Target{VersionDir: live.Dir, StateDir: stateDir, Version: to}); err != nil {
		return UpdateResult{}, err
	}
	if err := t.step("ready"); err != nil {
		return UpdateResult{}, err
	}
	if err := removeJournal(t.root); err != nil {
		return UpdateResult{}, err
	}
	t.journal = nil
	if err := t.step("committed"); err != nil {
		return UpdateResult{}, err
	}
	fields := []field{{"event", "updated"}, {"from", from}, {"to", to}, {"preUpdateCopy", preCopy}}
	if rehearsal != "" {
		fields = append(fields, field{"rehearsalCopy", rehearsal})
	}
	if err := logEvent(t.root, fields...); err != nil {
		return UpdateResult{}, err
	}
	return UpdateResult{From: from, To: to, PreUpdateCopy: preCopy}, nil
}

// fail logs a failed update and undoes its journal when there is one.
func (t *transaction) fail(err error) error {
	// A refusal after the journal exists (the state folder became a link before its copy) still
	// has to be undone like any other failure.
	if t.journal == nil && codeIs(err, CodeRefused, CodeBusy, CodeCorrupt) {
		_ = logEvent(t.root, field{"event", "refused"}, field{"release", t.releaseDir}, field{"reason", err.Error()})
		return err
	}
	if t.journal == nil {
		// Nothing to undo (a full disk while staging): the install is unchanged, say why.
		_ = logEvent(t.root, field{"event", "failed"}, field{"release", t.releaseDir}, field{"step", t.at},
			field{"code", errCode(err)}, field{"reason", err.Error()})
		return err
	}
	reason := err.Error()
	from, to := t.journal.From.Version, t.journal.To.Version
	if undoErr := undo(t.root, *t.journal); undoErr != nil {
		_ = logEvent(t.root, field{"event", "rollback-incomplete"}, field{"from", from}, field{"to", to},
			field{"step", t.at}, field{"reason", reason}, field{"error", undoErr.Error()})
		return rollbackIncomplete(fmt.Sprintf("Update to %s failed at %s and the rollback did not finish (%s)", to, t.at, undoErr.Error()), t.journal.PreCopy)
	}
	if logErr := logEvent(t.root, field{"event", "rolled-back"}, field{"from", from}, field{"to", to}, field{"step", t.at}, field{"reason", reason}); logErr != nil {
		return logErr
	}
	if t.rehearsal {
		return newError(CodeRolledBack, "Update to %s failed at rehearsal on a copy of the state folder; the state folder was not touched: %s", to, reason)
	}
	return newError(CodeRolledBack, "Update to %s failed at %s and was rolled back to %s: %s", to, t.at, from, reason)
}
