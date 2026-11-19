package pglitemove

import (
	"context"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5"
)

// prepared is a state folder as sipges-desktop --prepare-only leaves it, whose pg18 is the cluster
// the test server serves (a link to its data folder), and its mark.
func prepared(t *testing.T) string {
	t.Helper()
	server(t)
	return preparedWith(t, filepath.Join(shared.dir, "pg18"))
}

// preparedWith is a prepared state folder whose pg18 links to cluster, or is a new empty folder.
func preparedWith(t *testing.T, cluster string) string {
	t.Helper()
	dir := filepath.Join(t.TempDir(), "prepared-state")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	pg18 := filepath.Join(dir, "pg18")
	if cluster != "" {
		if err := os.Symlink(cluster, pg18); err != nil {
			t.Fatal(err)
		}
	} else if err := os.Mkdir(pg18, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, PendingMoveName), []byte("synthetic\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	return dir
}

func mustMatch(t *testing.T, out string, patterns ...string) {
	t.Helper()
	for _, p := range patterns {
		if !regexp.MustCompile(p).MatchString(out) {
			t.Errorf("output does not match %q:\n%s", p, out)
		}
	}
}

func TestMoveCommitsWithNoDifferenceAndRemovesThePendingMark(t *testing.T) {
	copyDir := copyOf(t)
	before := digest(t, filepath.Join(copyDir, "pglite"))
	url, password := target(t)
	state := prepared(t)
	code, out := move(t, Options{State: copyDir, To: url, Prepared: state}, Hooks{})
	if code != ExitMoved {
		t.Fatalf("exit %d, want 0:\n%s", code, out)
	}
	mustMatch(t, out,
		`(?m)^Source: a copy of the state folder; @electric-sql/pglite 0\.5\.15 \(WebAssembly in Go\), pg_dump \(PostgreSQL\) 18\.`,
		`(?m)^Source database read and dumped \(PostgreSQL 18\d{4}\); the copy is unchanged$`,
		`(?m)^media_feeds: media_feeds_url_check re-parsed by the target to the same definition$`,
		`(?m)^Migrations applied between the two: none$`,
		`(?m)^module_records: 4 -> 4, identical$`,
		`(?m)^audit: 301 -> 301, identical$`,
		`(?m)^tenants: 2 -> 2, identical$`,
		`(?m)^login_failures: 3 -> 3, identical$`,
		`(?m)^schema_migrations: 2 -> 2, identical$`,
		`(?m)^Sequences: 2 -> 2, none decreased$`,
		`(?m)^Catalog \(.*\): \d+ -> \d+, identical$`,
		`(?m)^RESULT: no difference$`,
		`Moved: the target holds the copy, committed\.\nThe prepared cluster is ready: removed pg18\.pending-move\.\n$`,
	)
	noLeak(t, out, password)
	if _, err := os.Lstat(filepath.Join(state, PendingMoveName)); !os.IsNotExist(err) {
		t.Errorf("the pending-move mark is still there after a committed move: %v", err)
	}
	if after := digest(t, filepath.Join(copyDir, "pglite")); after != before {
		t.Errorf("the copy's pglite folder changed: %s -> %s", before, after)
	}

	// The restored rows are what the API reads under row-level security, as the tenant role, and
	// the trigger and the identity column work on the target.
	ctx := context.Background()
	conn, err := pgx.Connect(ctx, url)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = conn.Close(ctx) }()
	tx, err := conn.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	for _, sql := range []string{
		"SET LOCAL ROLE sipges_tenant",
		"SELECT set_config('app.tenant_id', 'SIPGES/" + secret + "-ALFA', true), set_config('app.clearance', 'limited', true)",
	} {
		if _, err := tx.Exec(ctx, sql); err != nil {
			t.Fatal(err)
		}
	}
	rows, err := tx.Query(ctx, "SELECT id FROM module_records ORDER BY id")
	if err != nil {
		t.Fatal(err)
	}
	ids, err := pgx.CollectRows(rows, pgx.RowTo[string])
	if err != nil {
		t.Fatal(err)
	}
	if want := []string{secret + "-AC-1", secret + "-EV-1"}; !slices.Equal(ids, want) {
		t.Errorf("tenant isolation or the restricted marking did not survive: %v, want %v", ids, want)
	}
	if _, err := tx.Exec(ctx, "RESET ROLE"); err != nil {
		t.Fatal(err)
	}
	var touched bool
	if err := tx.QueryRow(ctx, `UPDATE module_records SET payload = '{}' WHERE id = '`+secret+`-EV-1'
	  RETURNING updated_at > '2026-06-01'`).Scan(&touched); err != nil || !touched {
		t.Errorf("the plpgsql trigger did not run on the target: %v %v", err, touched)
	}
	var id int64
	if err := tx.QueryRow(ctx, `INSERT INTO tenants (tenant_id, label) VALUES ('x', 'y') RETURNING id`).Scan(&id); err != nil || id != 3 {
		t.Errorf("the identity column did not continue after the copy: %v %d", err, id)
	}
}

func TestMoveWithADifferenceCommitsNothingAndKeepsThePendingMark(t *testing.T) {
	url, _ := target(t)
	state := prepared(t)
	code, out := move(t, Options{State: copyOf(t), To: url, Prepared: state}, Hooks{
		// A value changed between the restore and the comparison, as a lossy restore would.
		AfterRestore: func(ctx context.Context, tx Tx) error {
			_, err := tx.Exec(ctx, "UPDATE tenants SET label = label || ' cambiado'")
			return err
		},
	})
	if code != ExitDifferent {
		t.Fatalf("exit %d, want 1:\n%s", code, out)
	}
	mustMatch(t, out,
		`(?m)^tenants: 2 -> 2, 2 differences:$`,
		`(?m)^  row \[[0-9a-f]{8}\] differs in label, label_upper$`,
		`(?m)^RESULT: 2 differences$`,
		`Nothing was committed: the target is as it was before\.\n$`,
	)
	noLeak(t, out, "cambiado")
	if n := tableCount(t, url); n != 0 {
		t.Errorf("the target kept %d tables after a difference", n)
	}
	if _, err := os.Lstat(filepath.Join(state, PendingMoveName)); err != nil {
		t.Errorf("the pending-move mark was removed after a difference: %v", err)
	}
}

// Each of these changes something the rows do not show, as a lossy restore could: the proof must
// see it, exit 1 and roll back.
func TestMoveSeesALossyRestoreOfTheStructure(t *testing.T) {
	cases := []struct{ name, change, want string }{
		{"column default dropped", `ALTER TABLE module_records ALTER COLUMN marking DROP DEFAULT`, `column module_records\.marking: differs`},
		{"sequence increment changed", `ALTER SEQUENCE audit_id_seq INCREMENT BY 7`, `sequence public\.audit_id_seq: differs`},
		{"column collation changed", `ALTER TABLE audit ALTER COLUMN detail TYPE text COLLATE "C"`, `column audit\.detail: differs`},
		{"table made unlogged", `ALTER TABLE login_failures SET UNLOGGED`, `table login_failures: differs`},
		{"storage parameter set", `ALTER TABLE audit SET (fillfactor = 50)`, `table audit: differs`},
		{"replica identity changed", `ALTER TABLE audit REPLICA IDENTITY FULL`, `table audit: differs`},
		{"table comment added", `COMMENT ON TABLE audit IS 'x'`, `table audit: differs`},
		{"default privileges added", `ALTER DEFAULT PRIVILEGES GRANT SELECT ON TABLES TO sipges_tenant`, `default privileges .*: new`},
		{"grant revoked", `REVOKE UPDATE ON module_records FROM sipges_tenant`, `grant relation public\.module_records to sipges_tenant UPDATE: missing after`},
		{"policy changed", `ALTER POLICY tenant_isolation ON module_records USING (true)`, `policy module_records\.tenant_isolation: differs`},
		{"function changed", `CREATE OR REPLACE FUNCTION touch_updated_at() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$`, `function public\.touch_updated_at\(\): differs`},
		{"trigger disabled", `ALTER TABLE module_records DISABLE TRIGGER module_records_touch`, `module_records: structure differs: trigger module_records_touch enabled O -> D`},
		{"loosened CHECK", `ALTER TABLE media_feeds DROP CONSTRAINT media_feeds_url_check, ADD CONSTRAINT media_feeds_url_check CHECK (length(url) > 0)`, `media_feeds_url_check differs`},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			url, _ := target(t)
			code, out := move(t, Options{State: copyOf(t), To: url}, Hooks{
				AfterRestore: func(ctx context.Context, tx Tx) error {
					_, err := tx.Exec(ctx, c.change)
					return err
				},
			})
			if code != ExitDifferent {
				t.Fatalf("exit %d, want 1:\n%s", code, out)
			}
			mustMatch(t, out, c.want, `Nothing was committed`)
			noLeak(t, out)
			if n := tableCount(t, url); n != 0 {
				t.Errorf("the target kept %d tables after a difference", n)
			}
		})
	}
}

func TestMoveRefusesATargetThatIsNotEmpty(t *testing.T) {
	url, _ := target(t)
	name := url[strings.LastIndex(url, "/")+1 : strings.Index(url, "?")]
	adminExec(t, name, "CREATE TABLE already_here (id int)", "ALTER TABLE already_here OWNER TO "+name)
	copyDir := copyOf(t)
	before := digest(t, filepath.Join(copyDir, "pglite"))
	code, out := move(t, Options{State: copyDir, To: url}, Hooks{})
	if code != ExitNotMoved {
		t.Fatalf("exit %d, want 2:\n%s", code, out)
	}
	mustMatch(t, out, `RESULT: not moved: the target database is not empty`)
	noLeak(t, out)
	if n := tableCount(t, url); n != 1 {
		t.Errorf("the target holds %d tables, want only the one it had", n)
	}
	if after := digest(t, filepath.Join(copyDir, "pglite")); after != before {
		t.Error("the copy changed")
	}
}

func TestMoveRefusesASuperuserLogin(t *testing.T) {
	code, out := move(t, Options{State: copyOf(t), To: server(t).SuperUserURL("postgres")}, Hooks{})
	if code != ExitNotMoved {
		t.Fatalf("exit %d, want 2:\n%s", code, out)
	}
	mustMatch(t, out, `RESULT: not moved: the target login is a superuser or has BYPASSRLS`)
	noLeak(t, out, "synthetic-test-only")
}

func TestMoveStoppedDuringTheRestoreRollsBackAndRemovesTheScratchCopy(t *testing.T) {
	url, _ := target(t)
	scratch := t.TempDir()
	stop := &Stop{}
	code, out := move(t, Options{State: copyOf(t), To: url, Scratch: scratch}, Hooks{
		Stop: stop,
		AfterRestore: func(context.Context, Tx) error {
			stop.Signal(&strings.Builder{})
			return nil
		},
	})
	if code != ExitNotMoved {
		t.Fatalf("exit %d, want 2:\n%s", code, out)
	}
	mustMatch(t, out, `RESULT: not moved: interrupted; nothing was committed`)
	if n := tableCount(t, url); n != 0 {
		t.Errorf("the target kept %d tables after a stop", n)
	}
	if left, _ := os.ReadDir(scratch); len(left) != 0 {
		t.Errorf("the scratch folder still holds %d entries", len(left))
	}
}

func TestMoveReportsARefusedConnection(t *testing.T) {
	code, out := move(t, Options{State: copyOf(t), To: "postgres://nobody@127.0.0.1:1/none"}, Hooks{})
	if code != ExitNotMoved {
		t.Fatalf("exit %d, want 2:\n%s", code, out)
	}
	mustMatch(t, out, `could not connect to the target server \(ECONNREFUSED\): start it and check --to; nothing was written`)
	if strings.Contains(out, "file system error") {
		t.Errorf("a refused connection reads as a file system error:\n%s", out)
	}
}
