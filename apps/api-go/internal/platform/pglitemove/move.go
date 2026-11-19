// Package pglitemove is the one-time move of a desktop install's PGlite database into a native
// PostgreSQL 18 server, for the Go API (docs/adr/0036 §4), without Node: the Go port of
// deploy/desktop/migration/pglite-to-postgres.mjs, with the same guarantees.
//
// It reads a COPY of the state folder, never the original, and never opens even the copy: its
// pglite folder is copied to a scratch folder, only that is opened (PGlite writes to what it
// opens) with pglitewasm, served on loopback, and removed at the end. The copy is dumped with the
// native pg_dump 18 (plain SQL, --inserts, --no-owner) and restored into the target in ONE
// transaction, which also compares source and target table by table (tables.mjs, every table
// identical), plus functions, views, indexes, triggers, policies, grants, column defaults,
// identity, generation and collation, table persistence, storage options, replica identity,
// comments, sequence parameters, default privileges and extensions. Any difference rolls the
// transaction back: the target is left empty. The copy's pglite folder is hashed before and
// after and must not change. Values are never printed: counts, names and keyed fingerprints only.
//
// Exit code 0: moved, no difference; 1: a difference (nothing committed); 2: refused or failed.
package pglitemove

import (
	"context"
	"crypto/rand"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sync"
)

// Exit codes of the move, as pglite-to-postgres.mjs.
const (
	ExitMoved     = 0
	ExitDifferent = 1
	ExitNotMoved  = 2 // tables.mjs NOT_COMPARED_EXIT
)

// PendingMoveName is the mark `sipges-desktop --prepare-only` leaves beside <state>/pg18: nothing
// starts SIPGES on that empty cluster until a committed move with no difference removes it.
const PendingMoveName = "pg18.pending-move"

// PGliteVersion is the PGlite whose pglite.wasm the move runs (pglitewasm pins its files).
const PGliteVersion = "0.5.15"

// Options are the move's inputs; the CLI resolves the defaults.
type Options struct {
	State      string   // the copy of the state folder (--state); required
	To         string   // the target URL (--to or SIPGES_MOVE_DATABASE_URL); never printed
	Prepared   string   // the prepared real state folder (--prepared), or ""
	Scratch    string   // where the scratch copy goes (--scratch), default the temp folder
	Port       int      // where SIPGES answers when it runs (--port), default 8000
	PGliteDist string   // the pinned @electric-sql/pglite 0.5.15 dist folder
	PGBin      string   // the PostgreSQL 18 bin folder holding pg_dump
	Originals  []string // the original state folders, never read
}

// Hooks replace parts of the run in tests; the zero value is the real run.
type Hooks struct {
	// Answers reports whether SIPGES answers on a port (PortAnswers).
	Answers func(port int) bool
	// AfterRestore runs inside the transaction right after the dump loaded.
	AfterRestore func(ctx context.Context, tx Tx) error
	// Stop is the stop flag a signal sets.
	Stop *Stop
}

// Stop is set by a signal (Ctrl+C, SIGTERM, a closed terminal). A signal only asks the run to
// stop at its next step, which removes the scratch copy and rolls back an open transaction; once
// COMMIT was sent, the outcome is the server's.
type Stop struct {
	mu         sync.Mutex
	requested  bool
	work       string
	committing bool
}

// Signal records a stop request and says what happens next (pglite-to-postgres.mjs onSignal); it
// removes nothing itself.
func (s *Stop) Signal(say io.Writer) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.requested = true
	switch {
	case s.committing:
		_, _ = fmt.Fprintln(say, "Interrupted while committing: wait for the RESULT line; it says whether the move was committed.")
	case s.work != "":
		_, _ = fmt.Fprintf(say, "Interrupted: removing the scratch copy %s; wait for the RESULT line. If this window is closed first, delete that folder.\n", s.work)
	default:
		_, _ = fmt.Fprintln(say, "Interrupted: stopping; wait for the RESULT line.")
	}
}

func (s *Stop) set(f func(*Stop)) {
	s.mu.Lock()
	defer s.mu.Unlock()
	f(s)
}

func (s *Stop) checkpoint() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.requested {
		return refusef("interrupted; nothing was committed")
	}
	return nil
}

// errDifferent is a comparison that found a difference; the transaction was rolled back.
var errDifferent = errors.New("different")

// Run is the whole move; it prints its lines to out and returns the exit code.
func Run(ctx context.Context, o Options, out io.Writer, h Hooks) int {
	say := func(line string) { _, _ = fmt.Fprintln(out, line) }
	if h.Answers == nil {
		h.Answers = PortAnswers
	}
	if h.Stop == nil {
		h.Stop = &Stop{}
	}
	code, err := run(ctx, o, say, h)
	if errors.Is(err, errDifferent) {
		say("Nothing was committed: the target is as it was before.")
		return ExitDifferent
	}
	if err != nil {
		say("RESULT: not moved: " + safeReason(err))
		return ExitNotMoved
	}
	return code
}

func run(ctx context.Context, o Options, say func(string), h Hooks) (int, error) {
	if o.State == "" {
		return 0, refusef("--state <copy of the state folder> is required")
	}
	if o.Port == 0 {
		o.Port = 8000
	}
	if o.Port < 1 || o.Port > 65535 {
		return 0, refusef("invalid --port")
	}
	target, err := checkTarget(o.To)
	if err != nil {
		return 0, err
	}
	db, err := checkCopy(o.State, o.Originals)
	if err != nil {
		return 0, err
	}
	pending := ""
	if o.Prepared != "" {
		if pending, err = checkPrepared(o.Prepared); err != nil {
			return 0, err
		}
	}
	if o.Scratch == "" {
		o.Scratch = os.TempDir()
	}
	scratch, err := checkScratch(o.Scratch, filepath.Dir(db), o.Originals)
	if err != nil {
		return 0, err
	}
	if err := checkStopped(db, o.Port, h.Answers); err != nil {
		return 0, err
	}
	before, err := treeDigest(db)
	if err != nil {
		return 0, err
	}
	t, err := loadTools(ctx, o)
	if err != nil {
		return 0, err
	}
	say(fmt.Sprintf("Source: a copy of the state folder; @electric-sql/pglite %s (WebAssembly in Go), %s", PGliteVersion, t.pgDumpVersion))
	src, err := readSource(ctx, t, db, scratch, h.Stop)
	if err != nil {
		return 0, err
	}
	if after, err := treeDigest(db); err != nil {
		return 0, err
	} else if after != before {
		return 0, refusef("the copy changed while it was read: close every program using it and run again")
	}
	say(fmt.Sprintf("Source database read and dumped (PostgreSQL %s); the copy is unchanged", src.version))
	key := make([]byte, 32)
	if _, err := rand.Read(key); err != nil {
		return 0, err
	}
	if err := restore(ctx, target.String(), src, key, say, h); err != nil {
		return 0, err
	}
	say("Moved: the target holds the copy, committed.")
	if pending != "" {
		if err := os.Remove(pending); err != nil {
			say(fmt.Sprintf("The move committed, but %s could not be removed (%s): remove it from the prepared state folder by hand before opening SIPGES.", PendingMoveName, errnoName(err)))
			return ExitNotMoved, nil
		}
		say("The prepared cluster is ready: removed " + PendingMoveName + ".")
	}
	return ExitMoved, nil
}
