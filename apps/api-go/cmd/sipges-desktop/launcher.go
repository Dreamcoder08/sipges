package main

// The managed desktop launcher (--install): the Go port of deploy/desktop/updater/launcher.mjs.
// It recovers an interrupted update, runs the first start, serves the current version, checks the
// local release folder once and applies a verified update only when the person clicks
// «Actualizar», then serves the new version on the same port.
//
//   <root>/update-channel/status.json   written here: installed version and the verified update
//   <root>/update-channel/request.json  written by the API after the click (admin only)
//
// The API never decides what to install: a request names a version, and only the release this
// launcher verified for that version is applied, through desktopupdate.Update (verified again,
// with rollback). The event names and fields of the log are launcher.mjs's.

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"slices"
	"sync"
	"time"

	"github.com/Dreamcoder08/sipges/apps/api-go/internal/platform/desktoprelease"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/platform/desktopupdate"
)

const (
	// exitRollbackIncomplete: an update could not be rolled back; nothing is started on that state.
	exitRollbackIncomplete = 3
	// exitForced: a second stop signal killed the server without its graceful stop.
	exitForced  = 1
	statusName  = "status.json"
	requestName = "request.json"
)

// serverSpec is what one start of the server needs: the version to run and where.
type serverSpec struct {
	Current  *desktopupdate.Current
	StateDir string
	Channel  string
	Port     int
}

// server is a running SIPGES (PostgreSQL and the API). Exited is closed once it ended and
// everything it started is stopped; Code is then its exit code.
type server interface {
	Exited() <-chan struct{}
	Code() int
	// Stop asks it to end gracefully, forces it after the grace time, and waits.
	Stop(ctx context.Context) error
	// Kill ends it at once, without waiting.
	Kill()
}

// launchConfig is the launcher's configuration. Find, Migrate, Ready, Verifier and Serve are the
// real ones in production and stand-ins in tests.
type launchConfig struct {
	Root         string
	Source       string // the local release folder; empty disables the check
	Port         int
	Log          *eventLog
	CheckTimeout time.Duration
	Poll         time.Duration
	Find         func(root, source string) (*desktoprelease.Found, error)
	Migrate      desktopupdate.Hook
	Ready        desktopupdate.Hook
	Verifier     desktopupdate.Verifier
	Serve        func(ctx context.Context, spec serverSpec) (server, error)
	// StopOrphans stops PostgreSQL servers a dead launcher left running on these state folders
	// (the state folder and its copies); nil in tests that have none.
	StopOrphans func(ctx context.Context, folders []string) error
}

type launcher struct {
	cfg      launchConfig
	root     string
	stateDir string
	channel  string

	mu       sync.Mutex
	srv      server
	haltText string

	verified *desktoprelease.Available
	// ignoredRequest is the last half-written request.json, logged once and kept.
	ignoredRequest string
}

func newLauncher(cfg launchConfig) *launcher { return &launcher{cfg: cfg} }

// haltNotice is what the person reads in the console or shortcut window when SIPGES must not start.
func haltNotice(preUpdateCopy string) string {
	where := preUpdateCopy
	if where == "" {
		where = "previa a la actualización (junto a la carpeta de datos)"
	}
	return "SIPGES no se inició: una actualización falló y sus datos no se pudieron restaurar. No borre nada. Restaure la copia de seguridad " +
		where + " o contacte con soporte."
}

// firstStartNotice is what the person reads when the first start over existing data was refused
// or failed. Only a rollback that did not finish needs a restore; otherwise the data folder is as
// it was.
func firstStartNotice(err error) string {
	if ri, ok := rollbackIncomplete(err); ok {
		return haltNotice(ri.PreUpdateCopy)
	}
	return "SIPGES no se inició: la versión nueva no pudo abrir los datos existentes. Sus datos no se tocaron. No borre nada y contacte con soporte (detalle en launcher.log)."
}

func rollbackIncomplete(err error) (*desktopupdate.Error, bool) {
	var e *desktopupdate.Error
	if errors.As(err, &e) && e.Code == desktopupdate.CodeRollbackIncomplete {
		return e, true
	}
	return nil, false
}

// errorCode is Node's `error.code ?? null`.
func errorCode(err error) any {
	var ue *desktopupdate.Error
	if errors.As(err, &ue) {
		return string(ue.Code)
	}
	var re *desktoprelease.Error
	if errors.As(err, &re) {
		return string(re.Code)
	}
	return nil
}

// refuseUnmovedPGlite refuses a state folder whose database is still PGlite only.
func refuseUnmovedPGlite(root string) error {
	stateDir, err := desktopupdate.ReadStateDir(root)
	if err != nil {
		return nil //nolint:nilerr // the first start reports an invalid install.json itself
	}
	if holdsFiles(filepath.Join(stateDir, "pglite")) && !holdsFiles(filepath.Join(stateDir, dataFolder)) {
		return errors.New("The state folder holds PGlite data that was not moved to PostgreSQL 18") //nolint:staticcheck // ST1005: a log reason, like the updater's
	}
	return nil
}

func holdsFiles(dir string) bool {
	entries, err := os.ReadDir(dir)
	return err == nil && len(entries) > 0
}

// launcherLockName is the install root's file a running launcher holds locked.
const launcherLockName = "launcher.lock"

// errLauncherRunning: another launcher holds the install's lock.
var errLauncherRunning = errors.New("another sipges-desktop runs this install")

// acquireLauncherLock locks <root>/launcher.lock for this process; the system releases it when
// the process ends, however it ended.
func acquireLauncherLock(root string) (*os.File, error) {
	f, err := os.OpenFile(filepath.Join(root, launcherLockName), os.O_RDWR|os.O_CREATE, 0o600) //nolint:gosec // the install root's own lock
	if err != nil {
		return nil, err
	}
	if err := lockExclusive(f); err != nil {
		_ = f.Close()
		return nil, err
	}
	return f, nil
}

// orphanNotice is what the person reads when a PostgreSQL left running could not be stopped.
const orphanNotice = "SIPGES no se inició: un PostgreSQL de un inicio anterior sigue en ejecución sobre la carpeta de datos y no se pudo detener. No borre nada. Reinicie el equipo y vuelva a abrir SIPGES, o contacte con soporte."

// orphanError: a PostgreSQL left running could not be stopped; nothing was renamed.
type orphanError struct{ err error }

func (e *orphanError) Error() string { return e.err.Error() }
func (e *orphanError) Unwrap() error { return e.err }

// stateFolders are the state folder, every copy a pending journal names and every copy beside
// the state folder: wherever a killed launcher may have left PostgreSQL running.
func stateFolders(root string) []string {
	var folders []string
	add := func(dir string) {
		if dir != "" && !slices.Contains(folders, dir) {
			folders = append(folders, dir)
		}
	}
	if state, err := desktopupdate.ReadStateDir(root); err == nil {
		add(state)
	}
	if named, err := desktopupdate.JournalFolders(root); err == nil {
		for _, dir := range named {
			add(dir)
		}
	}
	if list, err := desktopupdate.ListStateCopies(root); err == nil {
		for _, c := range list.Copies {
			add(c.Path)
		}
	}
	return folders
}

func (l *launcher) stopOrphans(ctx context.Context) error {
	if l.cfg.StopOrphans == nil {
		return nil
	}
	return l.cfg.StopOrphans(ctx, stateFolders(l.root))
}

// firstStartError marks a startup error that came from the first start (its notice differs).
type firstStartError struct{ err error }

func (e *firstStartError) Error() string { return e.err.Error() }
func (e *firstStartError) Unwrap() error { return e.err }

// halted is the notice to print when the launcher ended on an update that did not roll back.
func (l *launcher) halted() string {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.haltText
}

// kill is the second stop: the server is killed now, without waiting for its graceful stop.
func (l *launcher) kill() {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.srv != nil {
		l.srv.Kill()
	}
}

func (l *launcher) server() server {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.srv
}

// run starts SIPGES and returns its exit code once it stopped. ctx ending is the person's stop.
// An error is a start that never got as far as a server: main prints its notice.
func (l *launcher) run(ctx context.Context) (int, error) {
	root, err := filepath.Abs(l.cfg.Root)
	if err != nil {
		return 0, err
	}
	l.root = root
	log := l.cfg.Log
	// One launcher per install: a second one is refused before it touches anything.
	lock, err := acquireLauncherLock(root)
	if err != nil {
		log.event("start_refused", field{"code", nil}, field{"reason", err.Error()})
		return 0, err
	}
	defer func() { _ = lock.Close() }()
	// A PostgreSQL that a killed launcher left running is stopped before recovery renames or
	// deletes the folder it runs on.
	if err := l.stopOrphans(ctx); err != nil {
		err = &orphanError{err}
		log.event("start_refused", field{"code", nil}, field{"reason", err.Error()}, field{"action", orphanNotice})
		return 0, err
	}
	recovered, err := desktopupdate.Recover(ctx, root)
	if err != nil {
		// The state may be half-migrated: starting any version on it would write on top of it.
		if ri, ok := rollbackIncomplete(err); ok {
			log.event("start_refused", field{"code", string(ri.Code)}, field{"reason", ri.Message},
				field{"action", haltNotice(ri.PreUpdateCopy)})
		}
		return 0, err
	}
	if recovered.Recovered && recovered.Current != nil {
		log.event("update_recovered", field{"version", recovered.Current.Version})
	}
	// PGlite data moves to PostgreSQL 18 only through the one-time migrator (ADR 0036 §4): a first
	// start here would build an empty pg18 beside it and serve an empty SIPGES.
	if stateDir, err := desktopupdate.ReadStateDir(root); err == nil && pendingMove(stateDir) {
		log.event("start_refused", field{"code", nil}, field{"reason", errPendingMove.Error()}, field{"action", pendingMoveNotice})
		return 0, &userError{msg: pendingMoveNotice, err: errPendingMove}
	}
	if err := refuseUnmovedPGlite(root); err != nil {
		log.event("start_refused", field{"code", nil}, field{"reason", err.Error()}, field{"action", firstStartNotice(err)})
		return 0, &firstStartError{err}
	}
	// Existing data opens only through a copy and a rehearsal, and before anything below could
	// create a secret in that folder.
	first, err := desktopupdate.FirstStart(ctx, desktopupdate.FirstStartOptions{Root: root, Migrate: l.cfg.Migrate})
	if err != nil {
		_, halt := rollbackIncomplete(err)
		if ctx.Err() != nil && !halt {
			// Stopped during the first start: its boot ended and the folder was put back.
			log.event("first_start_cancelled", field{"code", errorCode(err)}, field{"reason", err.Error()})
			return 0, nil
		}
		log.event("start_refused", field{"code", errorCode(err)}, field{"reason", err.Error()},
			field{"action", firstStartNotice(err)})
		return 0, &firstStartError{err}
	}
	if first.PreUpdateCopy != "" {
		log.event("first_start", field{"version", first.Version}, field{"preUpdateCopy", first.PreUpdateCopy})
	}
	if ctx.Err() != nil {
		return 0, nil
	}
	if l.stateDir, err = desktopupdate.ReadStateDir(root); err != nil {
		return 0, err
	}
	if err := prepareState(l.stateDir); err != nil {
		return 0, err
	}
	l.channel = filepath.Join(root, updateChannelFolder)
	if err := os.MkdirAll(l.channel, 0o700); err != nil {
		return 0, err
	}
	// A click from an earlier run never updates on this start.
	if err := os.Remove(filepath.Join(l.channel, requestName)); err != nil && !errors.Is(err, fs.ErrNotExist) {
		return 0, err
	}
	current, err := desktopupdate.ReadCurrent(root)
	if err != nil {
		return 0, err
	}
	if current == nil {
		return 0, errors.New("no installed version here")
	}
	l.publish(current.Version)
	if err := l.start(ctx); err != nil {
		if ctx.Err() != nil {
			return 0, nil
		}
		return 0, err
	}
	return l.loop(ctx), nil
}

type checkResult struct {
	found *desktoprelease.Found
	err   error
}

// loop serves until a stop, the server's own end, or an update that halts.
func (l *launcher) loop(ctx context.Context) int {
	var checked chan checkResult
	if l.cfg.Source != "" {
		// The check runs beside the server and never delays or stops it: one line whatever happens.
		checked = make(chan checkResult, 1)
		go func() {
			found, err := l.find(l.cfg.Source)
			checked <- checkResult{found, err}
		}()
	}
	tick := time.NewTicker(l.cfg.Poll)
	defer tick.Stop()
	for {
		var exited <-chan struct{}
		if srv := l.server(); srv != nil {
			exited = srv.Exited()
		}
		select {
		case <-ctx.Done():
			if l.stopServer(ctx) != nil {
				return 1
			}
			return 0
		case <-exited:
			// Stopped by its own failure: the launcher ends with it.
			code := l.server().Code()
			l.setServer(nil)
			return code
		case r := <-checked:
			checked = nil
			l.checked(r)
		case <-tick.C:
			if code, end := l.takeRequest(ctx); end {
				return code
			}
		}
	}
}

func (l *launcher) checked(r checkResult) {
	if r.err != nil {
		l.cfg.Log.event("update_check_failed", field{"reason", r.err.Error()})
		return
	}
	l.verified = r.found.Available
	l.publish(r.found.Installed)
	var available any
	if r.found.Available != nil {
		available = r.found.Available.Version
	}
	skipped := make([]string, 0, len(r.found.Skipped))
	for _, s := range r.found.Skipped {
		skipped = append(skipped, s.Reason)
	}
	l.cfg.Log.event("update_check", field{"installed", r.found.Installed}, field{"available", available},
		field{"skipped", skipped})
}

// find runs the release search with the check timeout. FindUpdate cannot be interrupted: a late
// answer is dropped.
func (l *launcher) find(source string) (*desktoprelease.Found, error) {
	answer := make(chan checkResult, 1)
	go func() {
		found, err := l.cfg.Find(l.root, source)
		answer <- checkResult{found, err}
	}()
	timer := time.NewTimer(l.cfg.CheckTimeout)
	defer timer.Stop()
	select {
	case r := <-answer:
		return r.found, r.err
	case <-timer.C:
		return nil, fmt.Errorf("no answer within %d ms", l.cfg.CheckTimeout.Milliseconds())
	}
}

func (l *launcher) setServer(srv server) {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.srv = srv
}

// start serves the current version and logs `started` with the copies beside the state folder.
func (l *launcher) start(ctx context.Context) error {
	current, err := desktopupdate.ReadCurrent(l.root)
	if err != nil {
		return err
	}
	if current == nil {
		return errors.New("no installed version here")
	}
	srv, err := l.cfg.Serve(ctx, serverSpec{Current: current, StateDir: l.stateDir, Channel: l.channel, Port: l.cfg.Port})
	if err != nil {
		return err
	}
	l.setServer(srv)
	l.cfg.Log.event("started", field{"version", current.Version}, field{"port", l.cfg.Port},
		field{"stateCopies", l.copiesNow()})
	return nil
}

// copiesNow is how many copies the updater left beside the state folder and their size, or null.
func (l *launcher) copiesNow() any {
	list, err := desktopupdate.ListStateCopies(l.root)
	if err != nil {
		return nil
	}
	return map[string]any{"count": list.Count, "bytes": list.Bytes}
}

// stopServer stops the server, gracefully first, and waits for it. When the stop fails, a server
// that still runs is kept.
func (l *launcher) stopServer(ctx context.Context) error {
	srv := l.server()
	if srv == nil {
		return nil
	}
	// A stop request (ctx) must not cut the server's own graceful stop short.
	if err := srv.Stop(context.WithoutCancel(ctx)); err != nil {
		l.cfg.Log.event("stop_failed", field{"reason", err.Error()})
		select {
		case <-srv.Exited():
			l.setServer(nil)
		default:
		}
		return err
	}
	l.setServer(nil)
	return nil
}

// keepServing follows a stop that failed before an update: no update runs; a server that still
// runs is kept, one that ended is started again.
func (l *launcher) keepServing(ctx context.Context) (int, bool) {
	if l.server() != nil {
		return 0, false
	}
	if err := l.start(ctx); err != nil {
		l.cfg.Log.event("start_failed", field{"version", nil}, field{"reason", err.Error()})
		return stoppedOr(ctx, 1), true
	}
	return 0, false
}

// takeRequest reads and removes request.json and applies it when it names the verified version.
// end reports that the launcher must end with code.
func (l *launcher) takeRequest(ctx context.Context) (code int, end bool) {
	path := filepath.Join(l.channel, requestName)
	text, err := os.ReadFile(path) //nolint:gosec // the install root's own channel file
	if errors.Is(err, fs.ErrNotExist) {
		return 0, false
	}
	if err != nil {
		l.cfg.Log.event("update_request_failed", field{"reason", err.Error()})
		return 0, false
	}
	var request map[string]any
	if !json.Valid(text) {
		// Half written: kept (the API may still be writing it), logged once.
		if string(text) != l.ignoredRequest {
			l.ignoredRequest = string(text)
			l.cfg.Log.event("update_request_ignored", field{"version", nil}, field{"verified", l.verifiedVersion()})
		}
		return 0, false
	}
	l.ignoredRequest = ""
	if err := os.Remove(path); err != nil && !errors.Is(err, fs.ErrNotExist) {
		l.cfg.Log.event("update_request_failed", field{"reason", err.Error()})
		return 0, false
	}
	// Complete JSON that is not an object (null, an array, a string…) never becomes a request:
	// it is dropped and logged, not kept forever.
	if json.Unmarshal(text, &request) != nil || request == nil {
		l.cfg.Log.event("update_request_ignored", field{"version", nil}, field{"verified", l.verifiedVersion()})
		return 0, false
	}
	version := request["version"]
	asked, isString := version.(string)
	if l.verified == nil || !isString || asked != l.verified.Version {
		l.cfg.Log.event("update_request_ignored", field{"version", version}, field{"verified", l.verifiedVersion()})
		return 0, false
	}
	return l.apply(ctx, asked)
}

func (l *launcher) verifiedVersion() any {
	if l.verified == nil {
		return nil
	}
	return l.verified.Version
}

// stillVerified re-checks that the release folder holds exactly the version verified at startup.
func (l *launcher) stillVerified(version, release string) string {
	again, err := l.find(release)
	if err != nil {
		return err.Error()
	}
	if again.Available != nil && again.Available.Version == version && again.Available.Release == release {
		return ""
	}
	return fmt.Sprintf("The release folder no longer holds the verified version %s: %s", version, release)
}

func (l *launcher) apply(ctx context.Context, version string) (int, bool) {
	log := l.cfg.Log
	release := l.verified.Release
	refused := l.stillVerified(version, release)
	// SIPGES was stopped during the re-check: the click no longer counts.
	if ctx.Err() != nil {
		log.event("update_cancelled", field{"version", version})
		return 0, false
	}
	if refused != "" {
		l.verified = nil
		if current, err := desktopupdate.ReadCurrent(l.root); err == nil && current != nil {
			l.publish(current.Version)
		}
		log.event("update_request_refused", field{"version", version}, field{"reason", refused})
		return 0, false
	}
	log.event("update_started", field{"version", version})
	if l.stopServer(ctx) != nil {
		return l.keepServing(ctx)
	}
	if err := l.stopOrphans(ctx); err != nil {
		log.event("stop_failed", field{"reason", err.Error()})
		return l.keepServing(ctx)
	}
	result, err := desktopupdate.Update(ctx, desktopupdate.UpdateOptions{
		Root: l.root, Release: release, Verifier: l.cfg.Verifier,
		Migrate: l.cfg.Migrate, Ready: l.cfg.Ready, ExpectVersion: version,
	})
	if err != nil {
		fields := []field{{"version", version}, {"code", errorCode(err)}, {"reason", err.Error()}}
		if ri, ok := rollbackIncomplete(err); ok {
			// Never start a version on a state folder that was not restored.
			notice := haltNotice(ri.PreUpdateCopy)
			l.mu.Lock()
			l.haltText = notice
			l.mu.Unlock()
			log.event("update_failed", append(fields, field{"action", notice})...)
			return exitRollbackIncomplete, true
		}
		log.event("update_failed", fields...)
	} else {
		log.event("updated", field{"from", result.From}, field{"to", result.To}, field{"preUpdateCopy", result.PreUpdateCopy})
	}
	l.verified = nil
	// From here SIPGES runs again or the launcher ends: never left without a server.
	current, err := desktopupdate.ReadCurrent(l.root)
	if err == nil && current == nil {
		err = errors.New("no installed version here")
	}
	if err != nil {
		log.event("start_failed", field{"version", nil}, field{"reason", err.Error()})
		return stoppedOr(ctx, 1), true
	}
	l.publish(current.Version)
	if ctx.Err() != nil {
		return 0, true
	}
	if err := l.start(ctx); err != nil {
		// A failed start set no server: nothing is left to stop.
		log.event("start_failed", field{"version", current.Version}, field{"reason", err.Error()})
		return stoppedOr(ctx, 1), true
	}
	return 0, false
}

func stoppedOr(ctx context.Context, code int) int {
	if ctx.Err() != nil {
		return 0
	}
	return code
}

type statusAvailable struct {
	Version string  `json:"version"`
	Notes   *string `json:"notes"`
}

type statusDoc struct {
	Format    int              `json:"format"`
	Installed string           `json:"installed"`
	Available *statusAvailable `json:"available"`
	CheckedAt string           `json:"checkedAt"`
}

// publish writes status.json. It only feeds the notice in the app: failing never stops SIPGES.
func (l *launcher) publish(installed string) {
	doc := statusDoc{Format: 1, Installed: installed, CheckedAt: isoTime(time.Now())}
	if l.verified != nil {
		doc.Available = &statusAvailable{Version: l.verified.Version, Notes: l.verified.Notes}
	}
	if err := writeJSONAtomic(filepath.Join(l.channel, statusName), doc); err != nil {
		l.cfg.Log.event("status_write_failed", field{"reason", err.Error()})
	}
}
