-- Automation and integration (docs/adr/0014-automation-and-integration.md). Every table is
-- tenant-owned under forced RLS, except api_keys, which is looked up before a tenant is known.

CREATE TABLE integration_channels (
  id           integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id    text NOT NULL REFERENCES tenants (tenant_id) ON DELETE CASCADE,
  kind         text NOT NULL
    CHECK (kind IN ('webhook', 'slack', 'teams', 'discord', 'gchat', 'telegram', 'email')),
  name         text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 80),
  -- Non-secret description of the destination (host or masked address) for the screen.
  target_hint  text NOT NULL DEFAULT '' CHECK (char_length(target_hint) <= 200),
  -- AES-256-GCM sealed JSON (URL, token, signing secret...), never returned by the API.
  sealed_config text NOT NULL,
  created_by   text NOT NULL,
  created_at   timestamptz NOT NULL,
  UNIQUE (tenant_id, name)
);

CREATE TABLE automation_rules (
  id              integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id       text NOT NULL REFERENCES tenants (tenant_id) ON DELETE CASCADE,
  name            text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 80),
  enabled         boolean NOT NULL DEFAULT true,
  trigger_module  text NOT NULL CHECK (char_length(trigger_module) BETWEEN 1 AND 60),
  trigger_actions text[] NOT NULL CHECK (cardinality(trigger_actions) BETWEEN 1 AND 10),
  conditions      jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(conditions) = 'array'),
  actions         jsonb NOT NULL CHECK (jsonb_typeof(actions) = 'array'),
  created_by      text NOT NULL,
  created_at      timestamptz NOT NULL,
  updated_at      timestamptz NOT NULL,
  UNIQUE (tenant_id, name)
);

-- Last audit row each tenant's engine has matched against its rules.
CREATE TABLE automation_cursors (
  tenant_id     text PRIMARY KEY REFERENCES tenants (tenant_id) ON DELETE CASCADE,
  last_audit_id integer NOT NULL DEFAULT 0
);

CREATE TABLE automation_runs (
  id              integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id       text NOT NULL REFERENCES tenants (tenant_id) ON DELETE CASCADE,
  rule_id         integer NOT NULL REFERENCES automation_rules (id) ON DELETE CASCADE,
  audit_id        integer NOT NULL,
  action_index    smallint NOT NULL CHECK (action_index >= 0),
  kind            text NOT NULL,
  status          text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'done', 'failed')),
  attempts        integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL,
  last_error      text NOT NULL DEFAULT '',
  -- The matched event as seen at match time (restricted records carry no payload).
  event           jsonb NOT NULL,
  created_at      timestamptz NOT NULL,
  finished_at     timestamptz,
  UNIQUE (tenant_id, rule_id, audit_id, action_index)
);
CREATE INDEX automation_runs_due ON automation_runs (tenant_id, status, next_attempt_at);
CREATE INDEX automation_runs_recent ON automation_runs (tenant_id, id DESC);

CREATE TABLE notifications (
  id         integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id  text NOT NULL REFERENCES tenants (tenant_id) ON DELETE CASCADE,
  title      text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 200),
  body       text NOT NULL DEFAULT '' CHECK (char_length(body) <= 2000),
  module     text,
  record_id  text,
  marking    text NOT NULL DEFAULT 'interno' CHECK (marking IN ('publico', 'interno', 'restringido')),
  rule_id    integer REFERENCES automation_rules (id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL
);
CREATE INDEX notifications_recent ON notifications (tenant_id, id DESC);

CREATE TABLE notification_reads (
  tenant_id       text NOT NULL,
  notification_id integer NOT NULL REFERENCES notifications (id) ON DELETE CASCADE,
  username        text NOT NULL,
  read_at         timestamptz NOT NULL,
  PRIMARY KEY (notification_id, username)
);

CREATE TABLE api_keys (
  id          integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id   text NOT NULL REFERENCES tenants (tenant_id) ON DELETE CASCADE,
  name        text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 80),
  -- Public part of the key, shown in lists; the secret part is stored only as SHA-256.
  prefix      text NOT NULL UNIQUE CHECK (prefix ~ '^[a-f0-9]{12}$'),
  secret_hash text NOT NULL,
  access      text NOT NULL CHECK (access IN ('read', 'write')),
  clearance   text NOT NULL CHECK (clearance IN ('limited', 'full')),
  created_by  text NOT NULL,
  created_at  timestamptz NOT NULL,
  last_used_at timestamptz,
  revoked_at  timestamptz,
  UNIQUE (tenant_id, name)
);

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['integration_channels', 'automation_rules', 'automation_runs',
                           'notification_reads']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY tenant_rows ON %I
      USING (tenant_id = current_setting('app.tenant_id', true))
      WITH CHECK (tenant_id = current_setting('app.tenant_id', true))$p$, t);
  END LOOP;
END
$$;

-- Cursors: RLS applies to the tenant role but not to the owner, so the scheduler can list the
-- tenants that have automations before entering any of them. Cursors hold only an audit id.
ALTER TABLE automation_cursors ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_rows ON automation_cursors
  USING (tenant_id = current_setting('app.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true));

-- Notifications about restricted records follow the record's marking (ADR 0012).
ALTER TABLE notifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE notifications FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_rows ON notifications
  USING (tenant_id = current_setting('app.tenant_id', true) AND mascli_can_see(marking))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true));

GRANT SELECT, INSERT, UPDATE, DELETE ON integration_channels, automation_rules, automation_runs
  TO mascli_tenant;
GRANT SELECT, INSERT, UPDATE ON automation_cursors TO mascli_tenant;
GRANT SELECT, INSERT ON notifications TO mascli_tenant;
GRANT SELECT, INSERT, DELETE ON notification_reads TO mascli_tenant;
