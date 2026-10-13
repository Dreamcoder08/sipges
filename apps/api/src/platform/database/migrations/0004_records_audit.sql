-- Territorial records and audit trail (docs/migration/records.md). Both are tenant-owned:
-- forced RLS on app.tenant_id, written and read only as the least-privilege role mascli_tenant.

CREATE TABLE module_records (
  tenant_id  text NOT NULL REFERENCES tenants (tenant_id) ON DELETE CASCADE,
  module     text NOT NULL,
  id         text NOT NULL,
  payload    jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, module, id)
);
CREATE INDEX module_records_recent ON module_records (tenant_id, module, updated_at DESC, id DESC);

-- Append-only for the application role: no UPDATE or DELETE grant.
CREATE TABLE audit (
  id        integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY, -- int4: same JSON number on every driver
  tenant_id text NOT NULL REFERENCES tenants (tenant_id) ON DELETE CASCADE,
  ts        timestamptz NOT NULL,
  module    text NOT NULL,
  record_id text,
  action    text NOT NULL,
  detail    text
);
CREATE INDEX audit_recent ON audit (tenant_id, id DESC);

ALTER TABLE module_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE module_records FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_rows ON module_records
  USING (tenant_id = current_setting('app.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true));

ALTER TABLE audit ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_rows ON audit
  USING (tenant_id = current_setting('app.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true));

GRANT SELECT, INSERT, UPDATE, DELETE ON module_records TO mascli_tenant;
GRANT SELECT, INSERT ON audit TO mascli_tenant;
GRANT USAGE ON SEQUENCE audit_id_seq TO mascli_tenant;
