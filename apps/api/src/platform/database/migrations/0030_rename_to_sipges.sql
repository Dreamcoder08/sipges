-- Renames the product from MASCLI to SIPGES in stored data (odd/tasks/rename-sipges.md):
--   1. the least-privilege role mascli_tenant becomes sipges_tenant with the same grants, and
--      the classification helper mascli_can_see becomes sipges_can_see (policies follow by oid);
--   2. tenant ids MASCLI/<project> become SIPGES/<project> in every table that has a tenant_id
--      (enumerated from the catalog), together with tenants.company_id;
--   3. the stored product name `MASCLI 4.0` becomes `SIPGES` in the alert origin (current rows
--      and their history) and in the audit module.
-- Every statement is idempotent and runs inside the migration transaction. The tenant tables
-- use forced RLS, whose WITH CHECK rejects a row that changes tenant, and composite foreign keys
-- cannot be updated one table at a time, so the rewrite lifts forced RLS, the history trigger
-- and the tenant foreign keys for its duration and restores each exactly as it found it.

-- 1. Role. Roles are cluster-wide, so creation must be idempotent across databases.
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'sipges_tenant') THEN
    CREATE ROLE sipges_tenant NOLOGIN NOINHERIT;
  END IF;
END
$$;

GRANT sipges_tenant TO CURRENT_USER;

DO $$
BEGIN
  IF to_regprocedure('mascli_can_see(text)') IS NOT NULL
     AND to_regprocedure('sipges_can_see(text)') IS NULL THEN
    ALTER FUNCTION mascli_can_see(text) RENAME TO sipges_can_see;
  END IF;
END
$$;

-- Moves everything mascli_tenant holds in this database to sipges_tenant, then drops the old
-- role. Dropping fails while another database of the cluster still grants it privileges, or
-- without the right to drop roles; the role is then kept, empty here.
DO $$
DECLARE
  old_role oid := (SELECT oid FROM pg_roles WHERE rolname = 'mascli_tenant');
  r record;
BEGIN
  IF old_role IS NULL THEN
    RETURN;
  END IF;

  FOR r IN
    SELECT member FROM pg_auth_members WHERE roleid = old_role
  LOOP
    EXECUTE format('GRANT sipges_tenant TO %s', r.member::regrole::text);
  END LOOP;

  IF has_schema_privilege('mascli_tenant', 'public', 'USAGE') THEN
    GRANT USAGE ON SCHEMA public TO sipges_tenant;
    BEGIN
      REVOKE ALL ON SCHEMA public FROM mascli_tenant;
    EXCEPTION WHEN insufficient_privilege THEN
      NULL;
    END;
  END IF;

  -- Column grants first: REVOKE ALL on a table also drops its column-level grants.
  FOR r IN
    SELECT a.attrelid::regclass::text AS rel,
           string_agg(DISTINCT x.privilege_type || ' (' || quote_ident(a.attname) || ')', ', ') AS privs
    FROM pg_attribute a
    JOIN pg_class c ON c.oid = a.attrelid AND c.relnamespace = 'public'::regnamespace
    CROSS JOIN LATERAL aclexplode(a.attacl) x
    WHERE x.grantee = old_role
    GROUP BY a.attrelid
  LOOP
    EXECUTE format('GRANT %s ON TABLE %s TO sipges_tenant', r.privs, r.rel);
    EXECUTE format('REVOKE %s ON TABLE %s FROM mascli_tenant', r.privs, r.rel);
  END LOOP;

  FOR r IN
    SELECT c.oid::regclass::text AS rel, c.relkind,
           string_agg(DISTINCT a.privilege_type, ', ') AS privs
    FROM pg_class c CROSS JOIN LATERAL aclexplode(c.relacl) a
    WHERE c.relnamespace = 'public'::regnamespace AND a.grantee = old_role
    GROUP BY c.oid, c.relkind
  LOOP
    EXECUTE format('GRANT %s ON %s %s TO sipges_tenant', r.privs,
                   CASE WHEN r.relkind = 'S' THEN 'SEQUENCE' ELSE 'TABLE' END, r.rel);
    EXECUTE format('REVOKE ALL ON %s %s FROM mascli_tenant',
                   CASE WHEN r.relkind = 'S' THEN 'SEQUENCE' ELSE 'TABLE' END, r.rel);
  END LOOP;

  FOR r IN
    SELECT p.oid::regprocedure::text AS fn
    FROM pg_proc p CROSS JOIN LATERAL aclexplode(p.proacl) a
    WHERE p.pronamespace = 'public'::regnamespace AND a.grantee = old_role
  LOOP
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO sipges_tenant', r.fn);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM mascli_tenant', r.fn);
  END LOOP;

  BEGIN
    DROP ROLE mascli_tenant;
  EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE 'mascli_tenant kept: %', SQLERRM;
  END;
END
$$;

-- 2 and 3. Tenant ids and stored product names.
DO $$
DECLARE
  r record;
  forced text[] := '{}';
  triggers text[] := '{}';
  foreign_keys text[] := '{}';
  cmd text;
BEGIN
  FOR r IN
    SELECT c.oid::regclass::text AS rel
    FROM pg_class c
    WHERE c.relnamespace = 'public'::regnamespace AND c.relkind = 'r' AND c.relforcerowsecurity
  LOOP
    forced := forced || r.rel;
    EXECUTE format('ALTER TABLE %s NO FORCE ROW LEVEL SECURITY', r.rel);
  END LOOP;

  FOR r IN
    SELECT t.tgrelid::regclass::text AS rel, t.tgname
    FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
    WHERE c.relnamespace = 'public'::regnamespace AND NOT t.tgisinternal AND t.tgenabled = 'O'
  LOOP
    triggers := triggers || format('%s %I', r.rel, r.tgname);
    EXECUTE format('ALTER TABLE %s DISABLE TRIGGER %I', r.rel, r.tgname);
  END LOOP;

  -- Foreign keys on a tenant id (to tenants or between tenant tables) are not deferrable.
  FOR r IN
    SELECT k.conrelid::regclass::text AS rel, k.conname, pg_get_constraintdef(k.oid) AS def
    FROM pg_constraint k
    WHERE k.contype = 'f' AND k.connamespace = 'public'::regnamespace
      AND (k.confrelid = 'tenants'::regclass
           OR EXISTS (SELECT FROM pg_attribute a
                      WHERE a.attrelid = k.conrelid AND a.attnum = ANY (k.conkey)
                        AND a.attname = 'tenant_id'))
  LOOP
    foreign_keys := foreign_keys || format('ALTER TABLE %s ADD CONSTRAINT %I %s', r.rel, r.conname, r.def);
    EXECUTE format('ALTER TABLE %s DROP CONSTRAINT %I', r.rel, r.conname);
  END LOOP;

  UPDATE tenants SET company_id = 'SIPGES' WHERE company_id = 'MASCLI';

  FOR r IN
    SELECT c.table_name
    FROM information_schema.columns c
    JOIN information_schema.tables t USING (table_schema, table_name)
    WHERE c.table_schema = 'public' AND t.table_type = 'BASE TABLE'
      AND c.column_name = 'tenant_id' AND c.table_name <> 'tenants'
  LOOP
    EXECUTE format('UPDATE %I SET tenant_id = ''SIPGES'' || substr(tenant_id, 7) WHERE tenant_id LIKE ''MASCLI/%%''',
                   r.table_name);
  END LOOP;

  UPDATE module_records SET payload = jsonb_set(payload, '{Origen}', '"SIPGES"')
  WHERE module = 'Alertas' AND payload->>'Origen' = 'MASCLI 4.0';
  UPDATE record_versions SET payload = jsonb_set(payload, '{Origen}', '"SIPGES"')
  WHERE module = 'Alertas' AND payload->>'Origen' = 'MASCLI 4.0';
  UPDATE audit SET module = 'SIPGES' WHERE module = 'MASCLI 4.0';

  FOREACH cmd IN ARRAY foreign_keys LOOP
    EXECUTE cmd;
  END LOOP;
  FOREACH cmd IN ARRAY triggers LOOP
    EXECUTE format('ALTER TABLE %s ENABLE TRIGGER %s', split_part(cmd, ' ', 1), split_part(cmd, ' ', 2));
  END LOOP;
  FOREACH cmd IN ARRAY forced LOOP
    EXECUTE format('ALTER TABLE %s FORCE ROW LEVEL SECURITY', cmd);
  END LOOP;
END
$$;
