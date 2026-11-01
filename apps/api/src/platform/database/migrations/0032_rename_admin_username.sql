-- Renames the administrator login mascli-admin to sipges-admin (odd/tasks/rename-admin-username.md),
-- a leftover of the MASCLI to SIPGES rename. It is the same person, so the account and every
-- stored attribution to it move together; in particular the four-eyes rule (0028) compares the
-- first validator with the current actor by name and must still see one person.
--   * Fails closed: if sipges-admin already exists, or any text column outside the reviewed
--     list below still holds the old name at the end, it raises and the migration transaction
--     rolls back, leaving every row, grant and session as it was.
--   * Idempotent: with no mascli-admin account it does nothing.
--   * The renamed columns are an explicit, reviewed list (table.column), matched on the exact
--     value, so another account, a lookalike (mascli-admin2) or a longer text is never touched.
--     Only the owner updates audit: the runtime role keeps INSERT only, no grant changes.
-- sessions, grants and push_subscriptions reference users (username) ON DELETE CASCADE without
-- ON UPDATE CASCADE and the keys are not deferrable, and forced RLS hides the tenant tables
-- from an owner without BYPASSRLS (a count of zero must never decide anything), so, as in
-- 0030 and 0031, the foreign keys to users and forced RLS are lifted for the duration and
-- restored exactly as found. No trigger sits on a table updated here (module_records, whose
-- history trigger would add a version, is not touched), so triggers are left enabled.
DO $$
DECLARE
  old_name constant text := 'mascli-admin';
  new_name constant text := 'sipges-admin';
  -- Columns that hold the account name or an attribution to it (actor, author, reviewer,
  -- validator, decider, creator, last editor, person responsible, notification recipient).
  renamed constant text[] := ARRAY[
    'users.username',
    'sessions.username',
    'grants.username',
    'push_subscriptions.username',
    'push_deliveries.username',
    'notification_reads.username',
    'api_keys.created_by',
    'integration_channels.created_by',
    'automation_rules.created_by',
    'record_links.created_by',
    'record_versions.actor',
    'link_evidence_history.actor',
    'attachments.author',
    'document_review.reviewer',
    'proposal_decisions.decided_by',
    'preventive_action_log.decided_by',
    'preventive_actions.responsible',
    'digital_alert_reviews.first_validator',
    'project_settings.updated_by',
    'source_import_settings.updated_by',
    'media_feeds.updated_by'
  ];
  pair text;
  r record;
  forced text[] := '{}';
  foreign_keys text[] := '{}';
  leftover text[] := '{}';
  cmd text;
  n bigint;
BEGIN
  IF NOT EXISTS (SELECT FROM users WHERE username = old_name) THEN
    RETURN;
  END IF;
  IF EXISTS (SELECT FROM users WHERE username = new_name) THEN
    RAISE EXCEPTION 'Cannot rename %: % already exists; nothing was changed', old_name, new_name;
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
    SELECT k.conrelid::regclass::text AS rel, k.conname, pg_get_constraintdef(k.oid) AS def
    FROM pg_constraint k
    WHERE k.contype = 'f' AND k.connamespace = 'public'::regnamespace
      AND k.confrelid = 'users'::regclass
  LOOP
    foreign_keys := foreign_keys || format('ALTER TABLE %s ADD CONSTRAINT %I %s', r.rel, r.conname, r.def);
    EXECUTE format('ALTER TABLE %s DROP CONSTRAINT %I', r.rel, r.conname);
  END LOOP;

  FOREACH pair IN ARRAY renamed LOOP
    EXECUTE format('UPDATE %I SET %I = $1 WHERE %I = $2',
                   split_part(pair, '.', 1), split_part(pair, '.', 2), split_part(pair, '.', 2))
      USING new_name, old_name;
  END LOOP;

  -- Login throttling keeps its failures under 'user:<name>': carry the count over.
  UPDATE login_failures SET subject = 'user:' || new_name WHERE subject = 'user:' || old_name;

  -- The alert store writes the first validator into the audit detail with two fixed templates
  -- (sql-alert-store.ts): 'Primera validación: <name>' and '<status> (primera validación: <name>)'.
  -- Only a detail that ends exactly with that name is rewritten; no other audit text is.
  UPDATE audit SET detail = 'Primera validación: ' || new_name
  WHERE detail = 'Primera validación: ' || old_name;
  UPDATE audit
  SET detail = left(detail, length(detail) - length(old_name) - 1) || new_name || ')'
  WHERE detail LIKE '% (primera validación: ' || old_name || ')';

  -- JSON payloads (module_records, record_versions and audit.event_payload copies of it,
  -- project_settings.settings, automation and push payloads, ingest receipts) are never
  -- rewritten. Their fields are written by people or by integrations (a record's `Responsable`
  -- is typed free text, not the login of the author) and the application stores the actor in
  -- dedicated columns, never in a payload field, so an exact match there cannot be told
  -- from prose. Report where the name still appears so the operator can review it.
  FOR r IN
    SELECT c.table_name, c.column_name, c.data_type
    FROM information_schema.columns c
    JOIN information_schema.tables t USING (table_schema, table_name)
    WHERE c.table_schema = 'public' AND t.table_type = 'BASE TABLE'
      AND c.data_type IN ('jsonb', 'json')
    ORDER BY c.table_name, c.column_name
  LOOP
    EXECUTE format('SELECT count(*) FROM %I WHERE %I::text LIKE $1', r.table_name, r.column_name)
      INTO n USING '%"' || old_name || '"%';
    IF n > 0 THEN
      RAISE NOTICE '%.% keeps % JSON rows with the string "%": payloads are not rewritten',
        r.table_name, r.column_name, n, old_name;
    END IF;
  END LOOP;

  -- Safety net over every text column of every table, not just the reviewed list: the exact
  -- old name (as a login, or as a throttling subject) must be gone. Columns that merely
  -- contain it inside a longer text (notes, notification bodies, audit texts outside the two
  -- templates above) are free text, reported but kept as written.
  FOR r IN
    SELECT c.table_name, c.column_name
    FROM information_schema.columns c
    JOIN information_schema.tables t USING (table_schema, table_name)
    WHERE c.table_schema = 'public' AND t.table_type = 'BASE TABLE'
      AND c.data_type IN ('text', 'character varying', 'character')
    ORDER BY c.table_name, c.column_name
  LOOP
    EXECUTE format('SELECT count(*) FROM %I WHERE %I IN ($1, $2)', r.table_name, r.column_name)
      INTO n USING old_name, 'user:' || old_name;
    IF n > 0 THEN
      leftover := leftover || format('%s.%s (%s rows)', r.table_name, r.column_name, n);
    END IF;
    EXECUTE format('SELECT count(*) FROM %I WHERE %I LIKE $1', r.table_name, r.column_name)
      INTO n USING '%' || old_name || '%';
    IF n > 0 THEN
      RAISE NOTICE '%.% still mentions % in % rows of free text: kept as written',
        r.table_name, r.column_name, old_name, n;
    END IF;
  END LOOP;
  IF cardinality(leftover) > 0 THEN
    RAISE EXCEPTION 'Cannot rename %: % still holds it; nothing was changed',
      old_name, array_to_string(leftover, ', ');
  END IF;

  FOREACH cmd IN ARRAY foreign_keys LOOP
    EXECUTE cmd;
  END LOOP;
  FOREACH cmd IN ARRAY forced LOOP
    EXECUTE format('ALTER TABLE %s FORCE ROW LEVEL SECURITY', cmd);
  END LOOP;
END
$$;
