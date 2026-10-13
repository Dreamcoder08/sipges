-- Indicators & IRSA (docs/adr/0003): tenant-owned tables isolated by forced RLS and accessed
-- only as the least-privilege role mascli_tenant inside withTenant transactions.
-- `json` (not jsonb) keeps key order: IRSA bands are evaluated in their configured order.

CREATE TABLE irsa_configs (
  tenant_id  text PRIMARY KEY REFERENCES tenants (tenant_id) ON DELETE CASCADE,
  config     json NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE irsa_snapshots (
  id             integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY, -- int4: same JSON number on every driver
  tenant_id      text NOT NULL REFERENCES tenants (tenant_id) ON DELETE CASCADE,
  ts             timestamptz NOT NULL,
  irsa           double precision NOT NULL,
  level          text NOT NULL,
  scores         json NOT NULL,
  config_version text,
  note           text
);
CREATE INDEX irsa_snapshots_tenant_id_idx ON irsa_snapshots (tenant_id, id DESC);

ALTER TABLE irsa_configs ENABLE ROW LEVEL SECURITY;
ALTER TABLE irsa_configs FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON irsa_configs
  USING (tenant_id = current_setting('app.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true));

ALTER TABLE irsa_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE irsa_snapshots FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON irsa_snapshots
  USING (tenant_id = current_setting('app.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true));

GRANT SELECT, INSERT, UPDATE ON irsa_configs TO mascli_tenant;
GRANT SELECT, INSERT ON irsa_snapshots TO mascli_tenant;
