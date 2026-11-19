package main

import (
	"context"
	"fmt"
	"io"
	"os"
	"os/signal"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"syscall"

	"github.com/Dreamcoder08/sipges/apps/api-go/internal/platform/desktopupdate"
	"github.com/Dreamcoder08/sipges/apps/api-go/internal/platform/pglitemove"
)

// pgliteDistFolder is where a release ships the pinned @electric-sql/pglite 0.5.15 dist files
// (pglite.wasm, pglite.data, pglite.js) inside <version>/go.
const pgliteDistFolder = "pglite"

// envMoveURL names the target in the environment, as pglite-to-postgres.mjs reads it: it keeps a
// password out of the process list.
const envMoveURL = "SIPGES_MOVE_DATABASE_URL"

const moveUsage = `Usage: SIPGES_MOVE_DATABASE_URL=postgres://<login>@127.0.0.1:<port>/<database> \
  sipges-desktop --move-pglite --state <copy of the state folder> [--prepared <state folder>]
  [--scratch <folder>] [--port 8000] [--pglite-dist <dir>] [--pg-bin <dir>]
Moves the PGlite database of a COPY of the state folder into an empty PostgreSQL 18 database, once,
without Node. --to <url> may replace the variable; --port is where SIPGES would answer if it were
running. --prepared names the state folder sipges-desktop --prepare-only prepared: its
pg18.pending-move is removed only after a committed move with no difference. The copy's pglite
folder is copied to --scratch (the temp folder by default) and only that copy is opened; it is
dumped with pg_dump 18, restored and compared in one transaction, which any difference rolls back.
--pglite-dist is the pinned @electric-sql/pglite 0.5.15 dist folder (default SIPGES_PGLITE_DIST,
else <version>/go/pglite of the managed install this program belongs to); --pg-bin is the
PostgreSQL 18 bin folder holding pg_dump (the managed install's <version>/postgresql/bin, else
--pg-bin or SIPGES_PG_BIN). Prints counts, names and keyed fingerprints, never a value or the URL.
Exit codes: 0 moved, no difference; 1 a difference, nothing committed; 2 refused or failed.`

// usesMovePGlite reports whether the arguments ask for the one-time PGlite move.
func usesMovePGlite(args []string) bool {
	for _, a := range args {
		if a == "--move-pglite" {
			return true
		}
	}
	return false
}

// moveOptions are the parsed --move-pglite options, before the defaults are resolved.
type moveOptions struct {
	help                                          bool
	state, to, prepared, scratch, port, dist, bin string
}

// parseMoveArgs follows parseLauncherArgs: --move-pglite once, valued options once each, never a
// value that starts with --, --name=value accepted, and --help.
func parseMoveArgs(args []string) (moveOptions, error) {
	var o moveOptions
	seen := map[string]bool{}
	for rest := args; len(rest) > 0; {
		key, value, inline := rest[0], "", false
		rest = rest[1:]
		if k, v, ok := strings.Cut(key, "="); ok && strings.HasPrefix(k, "--") {
			key, value, inline = k, v, true
		}
		if (key == "--move-pglite" || key == "--help") && !inline && !seen[key] {
			seen[key] = true
			o.help = o.help || key == "--help"
			continue
		}
		targets := map[string]*string{
			"--state": &o.state, "--to": &o.to, "--prepared": &o.prepared, "--scratch": &o.scratch,
			"--port": &o.port, "--pglite-dist": &o.dist, "--pg-bin": &o.bin,
		}
		target, ok := targets[key]
		if !ok || seen[key] {
			return moveOptions{}, errInvalidOptions
		}
		if !inline {
			if len(rest) == 0 {
				return moveOptions{}, errInvalidOptions
			}
			value, rest = rest[0], rest[1:]
		}
		if value == "" || strings.HasPrefix(value, "--") {
			return moveOptions{}, errInvalidOptions
		}
		seen[key] = true
		*target = value
	}
	return o, nil
}

// moveDefaults resolves what the options leave out: the target from SIPGES_MOVE_DATABASE_URL, the
// dist folder from SIPGES_PGLITE_DIST, and inside a managed install its current version's
// go/pglite and PostgreSQL 18 (resolveBins), the original state folders (the launcher's default
// and the one install.json records).
func moveDefaults(o moveOptions, lookup func(string) (string, bool), exeDir string) pglitemove.Options {
	m := pglitemove.Options{
		State: o.state, To: o.to, Prepared: o.prepared, Scratch: o.scratch,
		PGliteDist: o.dist,
	}
	if m.To == "" {
		m.To, _ = lookup(envMoveURL)
	}
	if o.port != "" {
		n, err := strconv.Atoi(o.port)
		if err != nil || n < 1 || n > 65535 {
			n = -1 // the move refuses it: invalid --port
		}
		m.Port = n
	}
	if m.PGliteDist == "" {
		m.PGliteDist, _ = lookup("SIPGES_PGLITE_DIST")
	}
	pgBin := o.bin
	if pgBin == "" {
		pgBin, _ = lookup("SIPGES_PG_BIN")
	}
	m.PGBin = pgBin
	home, _ := os.UserHomeDir()
	m.Originals = []string{pglitemove.OriginalState(lookup, runtime.GOOS, home)}
	if root := managedRoot(exeDir); root != "" {
		if state, err := desktopupdate.ReadStateDir(root); err == nil {
			m.Originals = append(m.Originals, state)
		}
		if cur, err := desktopupdate.ReadCurrent(root); err == nil && cur != nil {
			if bins, err := resolveBins(cur.Dir, pgBin); err == nil {
				m.PGBin = bins.pgBin
			}
			if dist := filepath.Join(cur.Dir, "go", pgliteDistFolder); m.PGliteDist == "" && isDir(dist) {
				m.PGliteDist = dist
			}
		}
	}
	return m
}

// runMovePGlite is the --move-pglite command line; it returns the exit code.
func runMovePGlite(ctx context.Context, args, environ []string, exeDir string, stdout, stderr io.Writer, h pglitemove.Hooks) int {
	o, err := parseMoveArgs(args)
	if err != nil {
		_, _ = fmt.Fprintln(stderr, moveUsage)
		return pglitemove.ExitNotMoved
	}
	if o.help {
		_, _ = fmt.Fprintln(stdout, moveUsage)
		return 0
	}
	return pglitemove.Run(ctx, moveDefaults(o, lookupIn(environ), exeDir), stdout, h)
}

// movePGliteMain runs the move: a signal only asks it to stop at its next step (it removes its
// scratch copy and rolls back an open transaction itself).
func movePGliteMain(args []string) int {
	stop := &pglitemove.Stop{}
	signals := make(chan os.Signal, 4)
	signal.Notify(signals, os.Interrupt, syscall.SIGTERM, syscall.SIGHUP)
	defer signal.Stop(signals)
	go func() {
		for range signals {
			stop.Signal(os.Stderr)
		}
	}()
	exeDir := ""
	if exe, err := os.Executable(); err == nil {
		exeDir = filepath.Dir(exe)
	}
	return runMovePGlite(context.Background(), args, os.Environ(), exeDir, os.Stdout, os.Stderr, pglitemove.Hooks{Stop: stop})
}
