package pglitemove

import (
	"context"
	"encoding/binary"
	"errors"
	"os"
	"path/filepath"
	"strconv"
	"strings"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

// clusterIdentity reads the fields of a cluster folder that identify the server running on it:
// the system identifier is the first field of global/pg_control (a uint64 in the host's byte
// order, as PostgreSQL writes it), and the fourth line of postmaster.pid is the port the
// postmaster listens on. ok is false when either cannot be read.
func clusterIdentity(dir string) (id uint64, port int, ok bool) {
	control, err := os.ReadFile(filepath.Join(dir, "global", "pg_control")) //nolint:gosec // the prepared cluster folder
	if err != nil || len(control) < 8 {
		return 0, 0, false
	}
	pid, err := os.ReadFile(filepath.Join(dir, "postmaster.pid")) //nolint:gosec // the prepared cluster folder
	if err != nil {
		return 0, 0, false
	}
	lines := strings.Split(strings.ReplaceAll(string(pid), "\r\n", "\n"), "\n")
	if len(lines) < 4 {
		return 0, 0, false
	}
	port, err = strconv.Atoi(strings.TrimSpace(lines[3]))
	if err != nil {
		return 0, 0, false
	}
	return binary.NativeEndian.Uint64(control[:8]), port, true
}

// checkServed refuses a --prepared folder whose pg18 the target does not serve, before anything is
// read or written: a wrong folder would lose its mark while the right cluster stays empty
// (pglite-to-postgres.mjs checkServed). The server's data_directory decides when the login may
// read it (pg_read_all_settings), and a different one refuses with no fallback; the API's login
// may not (SQLSTATE 42501), so then the cluster must match by system identifier
// (pg_control_system(), readable by any login) and by the port its postmaster.pid names, which is
// the port the target answered on.
func checkServed(ctx context.Context, targetURL, stateDir string) error {
	cluster := filepath.Join(stateDir, "pg18")
	wrong := refusef("el servidor de destino no sirve la carpeta %s de --prepared: indique la carpeta de datos que preparó sipges-desktop --prepare-only y arranque su clúster; no se escribió nada", cluster)
	real, err := filepath.EvalSymlinks(cluster)
	if err != nil {
		return wrong
	}
	cfg, err := targetConfig(targetURL)
	if err != nil {
		return err
	}
	conn, err := pgx.ConnectConfig(ctx, cfg)
	if err != nil {
		return connectFailure(err)
	}
	defer func() { _ = conn.Close(context.WithoutCancel(ctx)) }()
	var served string
	err = conn.QueryRow(ctx, "SHOW data_directory").Scan(&served)
	var pgErr *pgconn.PgError
	switch {
	case err == nil:
		if fold(realOr(served)) != fold(real) {
			return wrong
		}
		return nil
	case !errors.As(err, &pgErr) || pgErr.Code != "42501":
		return servedFailure(err)
	}
	var id int64
	var port int
	if err := conn.QueryRow(ctx, `SELECT system_identifier, inet_server_port() FROM pg_control_system()`).Scan(&id, &port); err != nil {
		return servedFailure(err)
	}
	// system_identifier is a bigint holding the same 64 bits: compared exactly, never as a float.
	localID, localPort, ok := clusterIdentity(real)
	if !ok || int64(localID) != id || localPort != port { //nolint:gosec // the same 64 bits, signed
		return wrong
	}
	return nil
}

// servedFailure: a broken connection says nothing was written; a server's answer keeps its SQLSTATE.
func servedFailure(err error) error {
	if connectionError(err) {
		return refusef("could not connect to the target server (%s): start it and check --to; nothing was written", failureCode(err))
	}
	return err
}

// removeCommand is the command that removes the mark by hand, for the shell the install uses.
func removeCommand(mark, goos string) string {
	if goos == "windows" {
		return "Remove-Item -LiteralPath '" + strings.ReplaceAll(mark, "'", "''") + "'"
	}
	return "rm -- '" + strings.ReplaceAll(mark, "'", `'\''`) + "'"
}
