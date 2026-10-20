-- MASCLI 4.0 per-project settings (docs/adr/0020 §1). One row per tenant; absent means
-- every default, including MASCLI 4.0 switched off.
CREATE TABLE project_settings (
  tenant_id  text PRIMARY KEY REFERENCES tenants (tenant_id) ON DELETE CASCADE,
  settings   jsonb NOT NULL,
  updated_by text NOT NULL,
  updated_at timestamptz NOT NULL
);

ALTER TABLE project_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE project_settings FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_rows ON project_settings
  USING (tenant_id = current_setting('app.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true));

GRANT SELECT, INSERT, UPDATE ON project_settings TO mascli_tenant;
