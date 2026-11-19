package pglitemove

import (
	"context"
	"strings"
	"testing"
)

// The independent verifier's probes (T3): each changes data or structure after the restore; the move must exit 1 and roll back.
func TestEveryChangeTheVerifierTriedRollsBack(t *testing.T) {
	cases := []struct{ name, change, want string }{
		{"force rls lost", `ALTER TABLE module_records NO FORCE ROW LEVEL SECURITY`, `module_records: structure differs: row-level security forced -> not forced`},
		{"rls disabled", `ALTER TABLE module_records DISABLE ROW LEVEL SECURITY`, `row-level security enabled -> disabled`},
		{"sequence advanced", `SELECT setval('audit_id_seq', 5000)`, `sequence audit_id_seq: last value differs`},
		{"duplicate lost without pk", `DELETE FROM login_failures WHERE ctid = (SELECT min(ctid) FROM login_failures WHERE username IS NOT NULL)`, `login_failures: 3 -> 2, 1 row missing or changed \(no primary key\)`},
		{"null became empty", `UPDATE audit SET detail = '' WHERE detail IS NULL`, `differs in detail`},
		{"real array changed", `UPDATE login_failures SET v = '{0.25,-1.50001}' WHERE v IS NOT NULL`, `login_failures: 3 -> 3, 2 differences`},
		{"jsonb changed", `ALTER TABLE module_records NO FORCE ROW LEVEL SECURITY;UPDATE module_records SET payload = payload || '{"n": 1.50}' WHERE payload ? 'n';ALTER TABLE module_records FORCE ROW LEVEL SECURITY`, `differs in payload`},
		{"index dropped", `DROP INDEX module_records_updated`, `index public.module_records_updated: missing after`},
		{"view changed", `CREATE OR REPLACE VIEW record_counts AS SELECT tenant_id, count(*) + 0 AS n FROM module_records GROUP BY tenant_id`, `view public.record_counts: differs`},
		{"identity lost", `ALTER TABLE tenants ALTER COLUMN id DROP IDENTITY`, `column tenants.id: differs`},
		{"column comment changed", `COMMENT ON COLUMN tenants.label IS 'other'`, `column tenants.label: differs`},
		{"not null dropped", `ALTER TABLE audit ALTER COLUMN action DROP NOT NULL`, `column action NOT NULL -> nullable`},
		{"extra table", `CREATE TABLE extra (x int)`, `extra: - -> 0, new table`},
		{"row added", `INSERT INTO audit (tenant_id, ts, action) VALUES ('t', now(), 'a')`, `row \[[0-9a-f]{8}\] new`},
		{"policy role changed", `ALTER POLICY tenant_isolation ON module_records TO public`, `policy module_records.tenant_isolation: differs`},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			url, _ := target(t)
			code, out := move(t, Options{State: copyOf(t), To: url}, Hooks{
				AfterRestore: func(ctx context.Context, tx Tx) error {
					for _, q := range strings.Split(c.change, ";") {
						if _, err := tx.Exec(ctx, q); err != nil {
							return err
						}
					}
					return nil
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
