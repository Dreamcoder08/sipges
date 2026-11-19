package pglitemove

import (
	"context"
	"fmt"
	"sort"
	"strings"

	"github.com/jackc/pgx/v5"
)

// querier is what both sides are read through: the source connection and the target transaction.
type querier interface {
	Query(ctx context.Context, sql string, args ...any) (pgx.Rows, error)
	QueryRow(ctx context.Context, sql string, args ...any) pgx.Row
}

// The schemas of the app, as pglite-to-postgres.mjs USER_SCHEMAS.
const userSchemas = `n.nspname NOT IN ('pg_catalog', 'information_schema')
  AND n.nspname NOT LIKE 'pg\_toast%' AND n.nspname NOT LIKE 'pg\_temp%'`

// relationName is the name readDatabase gives a relation: bare in public, schema-qualified elsewhere.
const relationName = `CASE WHEN n.nspname = 'public' THEN c.relname ELSE n.nspname || '.' || c.relname END`

func notExtension(oid string) string {
	return `NOT EXISTS (SELECT FROM pg_depend d WHERE d.objid = ` + oid + ` AND d.deptype = 'e')`
}

// role is a role as the catalog names it, the owner (who changes by design) as OWNER.
func role(oid, owner string) string {
	return `CASE WHEN ` + oid + ` = 0 THEN 'PUBLIC' WHEN ` + oid + ` = ` + owner + ` THEN 'OWNER' ELSE ` + oid + `::regrole::text END`
}

func ident(name string) string { return `"` + strings.ReplaceAll(name, `"`, `""`) + `"` }

// collect reads every row of a query with scan before the next query is sent.
func collect(ctx context.Context, q querier, sql string, args []any, scan func(pgx.Rows) error) error {
	rows, err := q.Query(ctx, sql, args...)
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		if err := scan(rows); err != nil {
			return err
		}
	}
	return rows.Err()
}

type tableRef struct {
	oid          uint32
	schema, name string
	rls, forced  bool
}

// readDatabase is tables.mjs readDatabase: every table of the app's schemas with its columns,
// primary key, rows as text and structure, and every sequence's last value.
func readDatabase(ctx context.Context, q querier) (*database, error) {
	var refs []tableRef
	err := collect(ctx, q, `SELECT c.oid, n.nspname, c.relname, c.relrowsecurity, c.relforcerowsecurity
     FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE c.relkind IN ('r', 'p') AND `+userSchemas, nil, func(r pgx.Rows) error {
		var t tableRef
		if err := r.Scan(&t.oid, &t.schema, &t.name, &t.rls, &t.forced); err != nil {
			return err
		}
		refs = append(refs, t)
		return nil
	})
	if err != nil {
		return nil, err
	}
	db := &database{tables: map[string]*table{}, sequences: map[string]*string{}}
	for _, ref := range refs {
		t, err := readTable(ctx, q, ref)
		if err != nil {
			return nil, err
		}
		name := ref.name
		if ref.schema != "public" {
			name = ref.schema + "." + ref.name
		}
		db.tables[name] = t
	}
	err = collect(ctx, q, `SELECT schemaname, sequencename, last_value::text FROM pg_sequences
     WHERE schemaname NOT IN ('pg_catalog', 'information_schema')`, nil, func(r pgx.Rows) error {
		var schema, name string
		var value *string
		if err := r.Scan(&schema, &name, &value); err != nil {
			return err
		}
		if schema != "public" {
			name = schema + "." + name
		}
		db.sequences[name] = value
		return nil
	})
	return db, err
}

func readTable(ctx context.Context, q querier, ref tableRef) (*table, error) {
	args := []any{ref.oid}
	t := &table{structure: structure{
		columns: map[string]column{}, keys: map[string]string{}, triggers: map[string]string{},
		rlsEnabled: ref.rls, rlsForced: ref.forced,
	}}
	err := collect(ctx, q, `SELECT attname, format_type(atttypid, atttypmod), attnotnull FROM pg_attribute
       WHERE attrelid = $1 AND attnum > 0 AND NOT attisdropped ORDER BY attnum`, args, func(r pgx.Rows) error {
		var name string
		var c column
		if err := r.Scan(&name, &c.typ, &c.notNull); err != nil {
			return err
		}
		t.columns = append(t.columns, name)
		t.structure.columnOrder = append(t.structure.columnOrder, name)
		t.structure.columns[name] = c
		return nil
	})
	if err != nil {
		return nil, err
	}
	err = collect(ctx, q, `SELECT a.attname FROM pg_index i, unnest(i.indkey) WITH ORDINALITY AS k(attnum, n)
       JOIN pg_attribute a ON a.attnum = k.attnum WHERE i.indrelid = $1 AND i.indisprimary
       AND a.attrelid = $1 ORDER BY k.n`, args, func(r pgx.Rows) error {
		var name string
		if err := r.Scan(&name); err != nil {
			return err
		}
		t.pk = append(t.pk, name)
		return nil
	})
	if err != nil {
		return nil, err
	}
	err = collect(ctx, q, `SELECT 'constraint ' || conname, pg_get_constraintdef(oid)
       FROM pg_constraint WHERE conrelid = $1
       UNION ALL SELECT 'unique index ' || c.relname, pg_get_indexdef(i.indexrelid)
       FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid WHERE i.indrelid = $1
       AND i.indisunique AND NOT EXISTS (SELECT FROM pg_constraint k WHERE k.conindid = i.indexrelid)`, args, func(r pgx.Rows) error {
		var name, def string
		if err := r.Scan(&name, &def); err != nil {
			return err
		}
		t.structure.keys[name] = def
		return nil
	})
	if err != nil {
		return nil, err
	}
	err = collect(ctx, q, `SELECT polname FROM pg_policy WHERE polrelid = $1`, args, func(r pgx.Rows) error {
		var name string
		if err := r.Scan(&name); err != nil {
			return err
		}
		t.structure.policies = append(t.structure.policies, name)
		return nil
	})
	if err != nil {
		return nil, err
	}
	sort.Strings(t.structure.policies)
	err = collect(ctx, q, `SELECT tgname, tgenabled::text FROM pg_trigger WHERE tgrelid = $1 AND NOT tgisinternal`, args, func(r pgx.Rows) error {
		var name, enabled string
		if err := r.Scan(&name, &enabled); err != nil {
			return err
		}
		t.structure.triggers[name] = enabled
		return nil
	})
	if err != nil {
		return nil, err
	}
	selects := make([]string, len(t.columns))
	for i, c := range t.columns {
		selects[i] = ident(c) + "::text"
	}
	list := strings.Join(selects, ", ")
	if list == "" {
		list = "NULL"
	}
	// Every value as text: a text column's binary and text formats are the same bytes.
	err = collect(ctx, q, fmt.Sprintf("SELECT %s FROM %s.%s", list, ident(ref.schema), ident(ref.name)), nil, func(r pgx.Rows) error {
		raw := r.RawValues()
		row := make([]*string, len(t.columns))
		for i := range row {
			if raw[i] != nil {
				v := string(raw[i])
				row[i] = &v
			}
		}
		t.rows = append(t.rows, row)
		return nil
	})
	if err != nil {
		return nil, err
	}
	return t, nil
}

// catalogQueries are what readDatabase does not compare (pglite-to-postgres.mjs readCatalog):
// each yields k (a name) and v (a digest or parameters, never a value of a row).
var catalogQueries = []struct{ label, sql string }{
	{"function", `SELECT n.nspname || '.' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' AS k,
         md5(pg_get_functiondef(p.oid)) AS v FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE ` + userSchemas + ` AND p.prokind IN ('f', 'p') AND ` + notExtension("p.oid")},
	{"view", `SELECT n.nspname || '.' || c.relname AS k, md5(pg_get_viewdef(c.oid)) AS v FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace WHERE ` + userSchemas + ` AND c.relkind IN ('v', 'm')`},
	{"index", `SELECT n.nspname || '.' || c.relname AS k, md5(concat_ws('|', pg_get_indexdef(i.indexrelid),
         i.indisreplident, i.indisclustered)) AS v
       FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace WHERE ` + userSchemas},
	{"trigger", `SELECT c.relname || '.' || t.tgname AS k, md5(pg_get_triggerdef(t.oid)) AS v FROM pg_trigger t
       JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE ` + userSchemas + ` AND NOT t.tgisinternal`},
	{"policy", `SELECT c.relname || '.' || p.polname AS k, md5(concat_ws('|', p.polcmd, p.polpermissive,
         (SELECT string_agg(r.name, ',' ORDER BY r.name) FROM (SELECT CASE WHEN x = 0 THEN 'PUBLIC'
           ELSE x::regrole::text END AS name FROM unnest(p.polroles) AS x) r),
         pg_get_expr(p.polqual, p.polrelid), pg_get_expr(p.polwithcheck, p.polrelid))) AS v
       FROM pg_policy p JOIN pg_class c ON c.oid = p.polrelid`},
	{"grant", `WITH objects AS (
         SELECT 'relation ' || n.nspname || '.' || c.relname AS name, c.relacl AS acl, c.relowner AS owner
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE ` + userSchemas + ` AND c.relacl IS NOT NULL
         UNION ALL SELECT 'column ' || n.nspname || '.' || c.relname || '.' || a.attname, a.attacl, c.relowner
         FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid
         JOIN pg_namespace n ON n.oid = c.relnamespace WHERE ` + userSchemas + ` AND a.attacl IS NOT NULL
         UNION ALL SELECT 'function ' || n.nspname || '.' || p.proname || '(' ||
           pg_get_function_identity_arguments(p.oid) || ')', p.proacl, p.proowner
         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE ` + userSchemas + ` AND p.proacl IS NOT NULL AND ` + notExtension("p.oid") + `
         UNION ALL SELECT 'schema ' || n.nspname, n.nspacl, n.nspowner FROM pg_namespace n
         WHERE ` + userSchemas + ` AND n.nspacl IS NOT NULL)
       SELECT o.name || ' to ' || CASE WHEN e.grantee = 0 THEN 'PUBLIC'
           WHEN e.grantee = o.owner THEN 'OWNER' ELSE e.grantee::regrole::text END
         || ' ' || e.privilege_type AS k, CASE WHEN e.is_grantable THEN 'grantable' ELSE '' END AS v
       FROM objects o, aclexplode(o.acl) e`},
	{"column", `SELECT ` + relationName + ` || '.' || a.attname AS k, md5(concat_ws('|',
         coalesce(pg_get_expr(d.adbin, d.adrelid), '-'), a.attidentity, a.attgenerated,
         coalesce(co.collname, '-'), coalesce(col_description(c.oid, a.attnum), '-'))) AS v
       FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
       LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
       LEFT JOIN pg_collation co ON co.oid = a.attcollation
       WHERE ` + userSchemas + ` AND c.relkind IN ('r', 'p') AND a.attnum > 0 AND NOT a.attisdropped`},
	{"table", `SELECT ` + relationName + ` AS k, md5(concat_ws('|', c.relpersistence,
         coalesce(array_to_string(c.reloptions, ','), '-'), c.relreplident,
         coalesce(obj_description(c.oid, 'pg_class'), '-'))) AS v
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE ` + userSchemas + ` AND c.relkind IN ('r', 'p')`},
	{"sequence", `SELECT n.nspname || '.' || c.relname AS k, concat_ws(' ', s.seqtypid::regtype::text,
         s.seqstart, s.seqincrement, s.seqmin, s.seqmax, s.seqcache, s.seqcycle, c.relpersistence) AS v
       FROM pg_sequence s JOIN pg_class c ON c.oid = s.seqrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace WHERE ` + userSchemas},
	{"default privileges", `SELECT 'of ' || ` + role("a.defaclrole", "(SELECT oid FROM pg_roles WHERE rolname = current_user)") + `
         || ' in ' || coalesce(n.nspname, 'every schema') || ' on ' || a.defaclobjtype::text
         || ' to ' || ` + role("e.grantee", "a.defaclrole") + ` || ' ' || e.privilege_type AS k,
         CASE WHEN e.is_grantable THEN 'grantable' ELSE '' END AS v
       FROM pg_default_acl a LEFT JOIN pg_namespace n ON n.oid = a.defaclnamespace,
         aclexplode(a.defaclacl) e`},
	{"extension", `SELECT e.extname AS k, e.extversion || ' in ' || n.nspname AS v
       FROM pg_extension e JOIN pg_namespace n ON n.oid = e.extnamespace`},
}

// readCatalog is pglite-to-postgres.mjs readCatalog: "<label> <name>" -> digest, so no
// definition text is ever printed.
func readCatalog(ctx context.Context, q querier) (map[string]string, error) {
	out := map[string]string{}
	for _, c := range catalogQueries {
		err := collect(ctx, q, c.sql, nil, func(r pgx.Rows) error {
			var k string
			var v *string
			if err := r.Scan(&k, &v); err != nil {
				return err
			}
			out[c.label+" "+k] = ""
			if v != nil {
				out[c.label+" "+k] = *v
			}
			return nil
		})
		if err != nil {
			return nil, err
		}
	}
	return out, nil
}

// sourceRole is a role other than the owner and PUBLIC that grants or policies name.
type sourceRole struct {
	name   string
	member bool // the source owner is a member
}

func readSourceRoles(ctx context.Context, q querier) ([]sourceRole, error) {
	var out []sourceRole
	err := collect(ctx, q, `WITH named AS (
       SELECT e.grantee AS role FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace,
         aclexplode(c.relacl) e WHERE `+userSchemas+` AND e.grantee <> c.relowner
       UNION SELECT e.grantee FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid
         JOIN pg_namespace n ON n.oid = c.relnamespace, aclexplode(a.attacl) e WHERE `+userSchemas+`
       UNION SELECT e.grantee FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace,
         aclexplode(p.proacl) e WHERE `+userSchemas+`
       UNION SELECT e.grantee FROM pg_namespace n, aclexplode(n.nspacl) e
         WHERE `+userSchemas+` AND e.grantee <> n.nspowner
       UNION SELECT x FROM pg_policy p, unnest(p.polroles) x)
     SELECT r.rolname, EXISTS (SELECT FROM pg_auth_members m WHERE m.roleid = r.oid
       AND m.member = (SELECT oid FROM pg_roles WHERE rolname = current_user))
     FROM named JOIN pg_roles r ON r.oid = named.role
     WHERE named.role <> 0 AND r.rolname NOT LIKE 'pg\_%' AND r.rolname <> current_user
     ORDER BY 1`, nil, func(r pgx.Rows) error {
		var s sourceRole
		if err := r.Scan(&s.name, &s.member); err != nil {
			return err
		}
		out = append(out, s)
		return nil
	})
	return out, err
}
