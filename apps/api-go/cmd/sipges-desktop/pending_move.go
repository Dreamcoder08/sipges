package main

import (
	"errors"
	"os"
	"path/filepath"
)

// pendingMoveName is the mark --prepare-only leaves beside <state>/pg18 until the one-time PGlite
// move (deploy/desktop/migration/pglite-to-postgres.mjs --prepared <state>) has filled the
// cluster and committed with no difference; that move removes it. While it is there the cluster
// holds no data yet: SIPGES must not start on it (it would migrate an empty database, which the
// move then refuses).
const pendingMoveName = dataFolder + ".pending-move"

// pendingMoveNotice is what the person reads; start-managed.ps1 and sipges-managed.sh say the same.
const pendingMoveNotice = "SIPGES no se inició en modo Go: sus datos todavía no se movieron a PostgreSQL. No se tocó nada. Abra SIPGES desde su acceso directo habitual."

// errPendingMove is the log reason for a cluster still waiting for the move.
var errPendingMove = errors.New("The PostgreSQL 18 cluster is waiting for the PGlite move (" + pendingMoveName + ")") //nolint:staticcheck // ST1005: a log reason, like the updater's

// pendingMove reports whether stateDir holds the mark of a cluster not filled yet.
func pendingMove(stateDir string) bool {
	_, err := os.Lstat(filepath.Join(stateDir, pendingMoveName))
	return err == nil
}
