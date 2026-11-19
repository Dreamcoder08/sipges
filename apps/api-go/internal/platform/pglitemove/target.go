package pglitemove

import (
	"context"
	"errors"
	"fmt"
	"strings"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

// Tx is the target transaction the restore, the comparison and AfterRestore run in.
type Tx = pgx.Tx

// reparsedChecks are the CHECKs whose printed text changes when the dump is parsed again,
// although the expression is the same: PGlite stored the BETWEEN of media_feeds_url_check (0026)
// as nested ANDs, and the target prints the re-parsed text as one flat AND. Only these are
// re-parsed; a text difference in any other constraint stays a difference. `table.constraint`.
var reparsedChecks = map[string]bool{"media_feeds.media_feeds_url_check": true}

// checkLogin refuses a server that is not 18 and a login that would own tables the Go API cannot
// serve (a superuser or BYPASSRLS).
func checkLogin(ctx context.Context, conn *pgx.Conn) error {
	var version int
	if err := conn.QueryRow(ctx, `SELECT current_setting('server_version_num')::int`).Scan(&version); err != nil {
		return err
	}
	if version < 180000 || version >= 190000 {
		return refusef("the target server is PostgreSQL %d; this move needs 18", version/10000)
	}
	var privileged bool
	if err := conn.QueryRow(ctx, `SELECT EXISTS (SELECT FROM pg_roles
    WHERE rolname IN (session_user, current_user) AND (rolsuper OR rolbypassrls))`).Scan(&privileged); err != nil {
		return err
	}
	if privileged {
		return refusef("the target login is a superuser or has BYPASSRLS: connect as the login the Go API serves with, so the tables belong to it and row-level security binds it")
	}
	return nil
}

func checkEmpty(ctx context.Context, tx pgx.Tx) error {
	var n int64
	err := tx.QueryRow(ctx, `SELECT (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE `+userSchemas+`)
     + (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE `+userSchemas+` AND `+notExtension("p.oid")+`)
     + (SELECT count(*) FROM pg_namespace n WHERE `+userSchemas+` AND n.nspname <> 'public')
     + (SELECT count(*) FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
       WHERE `+userSchemas+` AND t.typtype IN ('e', 'd', 'c', 'r')
       AND NOT EXISTS (SELECT FROM pg_class c WHERE c.oid = t.typrelid))`).Scan(&n)
	if err != nil {
		return err
	}
	if n > 0 {
		return refusef("the target database is not empty: the move only fills a new, empty database (nothing was written)")
	}
	return nil
}

// prepareRoles creates the roles the source grants to when missing, as the migrations create
// them (0003, 0030: no login, no inherited rights), and joins them as the source owner was.
func prepareRoles(ctx context.Context, tx pgx.Tx, roles []sourceRole) error {
	for _, r := range roles {
		var exists, joined bool
		err := tx.QueryRow(ctx, `SELECT EXISTS (SELECT FROM pg_roles WHERE rolname = $1),
        EXISTS (SELECT FROM pg_auth_members m JOIN pg_roles r ON r.oid = m.roleid
          WHERE r.rolname = $1 AND m.member = (SELECT oid FROM pg_roles WHERE rolname = current_user))`, r.name).Scan(&exists, &joined)
		if err == nil && !exists {
			_, err = tx.Exec(ctx, "CREATE ROLE "+ident(r.name)+" NOLOGIN NOINHERIT")
		}
		if err == nil && r.member && !joined {
			_, err = tx.Exec(ctx, "GRANT "+ident(r.name)+" TO CURRENT_USER")
		}
		if err != nil {
			if connectionError(err) {
				return err
			}
			return refusef("the target login cannot create or join the role %s (SQLSTATE %s): create it NOLOGIN NOINHERIT and grant it to the login first", r.name, sqlstate(err))
		}
	}
	return nil
}

// reparseChecks: for each CHECK of reparsedChecks whose text differs, the target parses the
// source's own definition on an empty temporary copy of the table's columns; only when that
// prints exactly what the restore made is the source's text taken as the target's.
func reparseChecks(ctx context.Context, tx pgx.Tx, source, target map[string]*table, say func(string)) error {
	for _, name := range sortedKeys(source) {
		other := target[name]
		if other == nil {
			continue
		}
		t := source[name]
		for _, key := range sortedKeys(t.structure.keys) {
			def := t.structure.keys[key]
			now, ok := other.structure.keys[key]
			constraint, isConstraint := strings.CutPrefix(key, "constraint ")
			if !ok || now == def || !isConstraint || !strings.HasPrefix(def, "CHECK") || !reparsedChecks[name+"."+constraint] {
				continue
			}
			schema, relation := "public", name
			if s, r, found := strings.Cut(name, "."); found {
				schema, relation = s, r
			}
			parsed, err := probeCheck(ctx, tx, schema, relation, def)
			if err != nil && connectionError(err) {
				return err
			}
			if err == nil && parsed == now {
				t.structure.keys[key] = now
				say(fmt.Sprintf("%s: %s re-parsed by the target to the same definition", name, constraint))
			}
		}
	}
	return nil
}

// probeCheck runs in a savepoint: a definition the target cannot parse leaves the difference,
// not an aborted transaction.
func probeCheck(ctx context.Context, tx pgx.Tx, schema, relation, def string) (parsed string, err error) {
	sp, err := tx.Begin(ctx)
	if err != nil {
		return "", err
	}
	defer func() {
		if err != nil {
			_ = sp.Rollback(ctx)
		}
	}()
	if _, err = sp.Exec(ctx, fmt.Sprintf("CREATE TEMP TABLE sipges_move_probe (LIKE %s.%s)", ident(schema), ident(relation))); err != nil {
		return "", err
	}
	if _, err = sp.Exec(ctx, "ALTER TABLE sipges_move_probe ADD CONSTRAINT sipges_move_probe_check "+def); err != nil {
		return "", err
	}
	if err = sp.QueryRow(ctx, `SELECT pg_get_constraintdef(oid) FROM pg_constraint
       WHERE conname = 'sipges_move_probe_check' AND conrelid = 'sipges_move_probe'::regclass`).Scan(&parsed); err != nil {
		return "", err
	}
	if _, err = sp.Exec(ctx, "DROP TABLE sipges_move_probe"); err != nil {
		return "", err
	}
	return parsed, sp.Commit(ctx)
}

// restore loads the dump, compares and commits in one transaction; any difference rolls
// everything back.
func restore(ctx context.Context, targetURL string, src *source, key []byte, say func(string), h Hooks) error {
	cfg, err := pgx.ParseConfig(targetURL)
	if err != nil {
		return refusef("the target must be a postgres:// URL to a database on 127.0.0.1, with no host override")
	}
	// Only 127.0.0.1, whatever the environment adds (checkTarget refused a host override).
	local := cfg.Host == "127.0.0.1"
	for _, f := range cfg.Fallbacks { // sslmode=prefer adds the same host without TLS
		local = local && f.Host == "127.0.0.1"
	}
	if !local {
		return refusef("the target must be a postgres:// URL to a database on 127.0.0.1, with no host override")
	}
	cfg.DefaultQueryExecMode = pgx.QueryExecModeDescribeExec
	cfg.RuntimeParams["application_name"] = "sipges-pglite-move"
	for _, kv := range session {
		cfg.RuntimeParams[kv[0]] = kv[1]
	}
	cfg.OnNotice = func(*pgconn.PgConn, *pgconn.Notice) {}
	conn, err := pgx.ConnectConfig(ctx, cfg)
	if err != nil {
		return connectFailure(err)
	}
	defer func() { _ = conn.Close(context.WithoutCancel(ctx)) }()
	if err := checkLogin(ctx, conn); err != nil {
		return midFailure(err)
	}
	tx, err := conn.Begin(ctx)
	if err != nil {
		return midFailure(err)
	}
	committed := false
	defer func() {
		if !committed {
			_ = tx.Rollback(context.WithoutCancel(ctx))
		}
	}()
	if err := compareInside(ctx, tx, src, key, say, h); err != nil {
		return midFailure(err)
	}
	if err := h.Stop.checkpoint(); err != nil {
		return err
	}
	// From here the outcome is the server's.
	h.Stop.set(func(s *Stop) { s.committing = true })
	defer h.Stop.set(func(s *Stop) { s.committing = false })
	committed = true
	if err := tx.Commit(ctx); err != nil {
		return refusef("the connection failed after COMMIT was sent (%s): the target may hold the move; check it before running again", failureCode(err))
	}
	return nil
}

func compareInside(ctx context.Context, tx pgx.Tx, src *source, key []byte, say func(string), h Hooks) error {
	if err := checkEmpty(ctx, tx); err != nil {
		return err
	}
	if err := prepareRoles(ctx, tx, src.roles); err != nil {
		return err
	}
	if _, err := tx.Conn().PgConn().Exec(ctx, src.dump).ReadAll(); err != nil {
		if connectionError(err) {
			return err
		}
		return refusef("the dump did not load into the target (SQLSTATE %s); nothing was committed", sqlstate(err))
	}
	// The dump sets row_security off and an empty search_path for the session: back to the
	// settings the source is read with, or definitions would print schema-qualified.
	if _, err := tx.Exec(ctx, "RESET ALL"); err != nil {
		return err
	}
	if h.AfterRestore != nil {
		if err := h.AfterRestore(ctx, tx); err != nil {
			return err
		}
	}
	if err := h.Stop.checkpoint(); err != nil {
		return err
	}
	// FORCE ROW LEVEL SECURITY binds the owner too, so its rows are read with it lifted and the
	// structure once it is back, all inside this transaction.
	var forced [][2]string
	err := collect(ctx, tx, `SELECT n.nspname, c.relname FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace WHERE `+userSchemas+` AND c.relforcerowsecurity`, nil,
		func(r pgx.Rows) error {
			var s, n string
			if err := r.Scan(&s, &n); err != nil {
				return err
			}
			forced = append(forced, [2]string{s, n})
			return nil
		})
	if err != nil {
		return err
	}
	for _, t := range forced {
		if _, err := tx.Exec(ctx, fmt.Sprintf("ALTER TABLE %s.%s NO FORCE ROW LEVEL SECURITY", ident(t[0]), ident(t[1]))); err != nil {
			return err
		}
	}
	rows, err := readDatabase(ctx, tx)
	if err != nil {
		return err
	}
	for _, t := range forced {
		if _, err := tx.Exec(ctx, fmt.Sprintf("ALTER TABLE %s.%s FORCE ROW LEVEL SECURITY", ident(t[0]), ident(t[1]))); err != nil {
			return err
		}
	}
	shape, err := readDatabase(ctx, tx)
	if err != nil {
		return err
	}
	for name, t := range rows.tables {
		if s := shape.tables[name]; s != nil {
			t.structure = s.structure
		}
	}
	if err := reparseChecks(ctx, tx, src.tables.tables, rows.tables, say); err != nil {
		return err
	}
	catalog, err := readCatalog(ctx, tx)
	if err != nil {
		return err
	}
	if report(src.tables, rows, src.catalog, catalog, key, say) {
		return errDifferent
	}
	return nil
}

// connectFailure is a failed connect: refused or unreachable says nothing was written; a
// server's answer (a wrong password) keeps its SQLSTATE.
func connectFailure(err error) error {
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) {
		return err
	}
	return refusef("could not connect to the target server (%s): start it and check --to; nothing was written", failureCode(err))
}

// midFailure turns a broken connection into its refusal; other errors pass.
func midFailure(err error) error {
	var r *Refusal
	if errors.As(err, &r) || errors.Is(err, errDifferent) || !connectionError(err) {
		return err
	}
	return refusef("the connection to the target server failed (%s); the server rolls back an open transaction, nothing was committed", failureCode(err))
}
