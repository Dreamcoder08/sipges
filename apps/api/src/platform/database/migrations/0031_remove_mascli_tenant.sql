-- Removes the MASCLI tenants left behind by 0030 (odd/tasks/remove-mascli-tenant.md). The old
-- Worker, still serving between `migrate` and `deploy`, re-created MASCLI/PRJ-SECHURA through
-- tenancy.bootstrap() and granted it to the administrators, so the project picker listed
-- Sechura twice.
--   * A MASCLI tenant that owns no row in any table with a tenant_id is deleted with its grants.
--   * A MASCLI tenant that owns rows has them moved to SIPGES/<project>. If that tenant does not
--     exist it is renamed instead (as 0030 did); nothing is ever deleted with data in it.
--   * A move that meets the same key in the SIPGES tenant raises, which rolls back the
--     migration transaction: no row, grant or tenant is changed or lost.
-- Idempotent: with no MASCLI tenant it does nothing. Forced RLS would hide the rows from the
-- owner (a count of zero must never decide a delete) and composite foreign keys cannot be
-- updated one table at a time, so, as in 0030, forced RLS, triggers and tenant foreign keys
-- are lifted for the duration and restored exactly as found.
DO $$
DECLARE
  r record;
  old record;
  forced text[] := '{}';
  triggers text[] := '{}';
  foreign_keys text[] := '{}';
  owned text[] := '{}';
  cmd text;
  target text;
  n bigint;
  found_rows bigint;
BEGIN
  IF NOT EXISTS (SELECT FROM tenants WHERE company_id = 'MASCLI') THEN
    RETURN;
  END IF;

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

  -- Every table owning rows by tenant id, enumerated from the catalog so none is missed.
  -- `tenants` is the tenant itself and `grants` is handled apart.
  SELECT coalesce(array_agg(c.table_name::text ORDER BY c.table_name), '{}') INTO owned
  FROM information_schema.columns c
  JOIN information_schema.tables x USING (table_schema, table_name)
  WHERE c.table_schema = 'public' AND x.table_type = 'BASE TABLE'
    AND c.column_name = 'tenant_id' AND c.table_name NOT IN ('tenants', 'grants');

  FOR old IN
    SELECT tenant_id, project_id FROM tenants WHERE company_id = 'MASCLI' ORDER BY project_id
  LOOP
    target := 'SIPGES/' || old.project_id;

    n := 0;
    FOREACH cmd IN ARRAY owned LOOP
      EXECUTE format('SELECT count(*) FROM %I WHERE tenant_id = $1', cmd) INTO found_rows USING old.tenant_id;
      n := n + found_rows;
    END LOOP;

    IF n > 0 THEN
      -- The destination keeps its own row; without one, the MASCLI tenant becomes it.
      IF NOT EXISTS (SELECT FROM tenants WHERE tenant_id = target) THEN
        UPDATE tenants SET company_id = 'SIPGES' WHERE tenant_id = old.tenant_id;
      END IF;

      FOREACH cmd IN ARRAY owned LOOP
        BEGIN
          EXECUTE format('UPDATE %I SET tenant_id = $1 WHERE tenant_id = $2', cmd)
            USING target, old.tenant_id;
        EXCEPTION WHEN unique_violation THEN
          RAISE EXCEPTION 'Cannot remove tenant %: table % already holds the same key under %; nothing was changed',
            old.tenant_id, cmd, target
            USING ERRCODE = 'unique_violation';
        END;
      END LOOP;

      -- Whoever could read the moved data keeps access to where it lives now.
      INSERT INTO grants (username, tenant_id, created_at)
      SELECT username, target, created_at FROM grants WHERE tenant_id = old.tenant_id
      ON CONFLICT DO NOTHING;
    END IF;

    -- Nothing may remain under the old id before it is dropped.
    FOREACH cmd IN ARRAY owned LOOP
      EXECUTE format('SELECT count(*) FROM %I WHERE tenant_id = $1', cmd) INTO found_rows USING old.tenant_id;
      IF found_rows > 0 THEN
        RAISE EXCEPTION 'Cannot remove tenant %: table % still holds % rows under it',
          old.tenant_id, cmd, found_rows;
      END IF;
    END LOOP;

    DELETE FROM grants WHERE tenant_id = old.tenant_id;
    DELETE FROM tenants WHERE tenant_id = old.tenant_id;
  END LOOP;

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

-- The administrator created on an empty database kept the product name in its display name.
-- Exact match only: no other account is touched, and a second run finds nothing to rename.
UPDATE users SET full_name = 'Administración SIPGES' WHERE full_name = 'Administración MASCLI Workers';
