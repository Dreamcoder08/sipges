-- Optional official metadata connector. Disabled until an operator documents authorization.
CREATE TABLE source_import_settings (
 tenant_id text NOT NULL REFERENCES tenants(tenant_id) ON DELETE CASCADE,
 source_id text NOT NULL CHECK (source_id = 'defensoria'),
 enabled boolean NOT NULL DEFAULT false,
 query text NOT NULL DEFAULT '' CHECK (char_length(query) <= 100),
 territory text NOT NULL DEFAULT '' CHECK (char_length(territory) <= 200),
 authorization_note text NOT NULL DEFAULT '' CHECK (char_length(authorization_note) <= 1000),
 revision integer NOT NULL DEFAULT 1,
 updated_by text NOT NULL,
 updated_at timestamptz NOT NULL,
 last_poll_at timestamptz,
 last_poll_error text NOT NULL DEFAULT '',
 last_imported integer NOT NULL DEFAULT 0,
 last_duplicates integer NOT NULL DEFAULT 0,
 PRIMARY KEY (tenant_id, source_id),
 CHECK (NOT enabled OR char_length(btrim(authorization_note)) > 0)
);
ALTER TABLE source_import_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE source_import_settings FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_rows ON source_import_settings
 USING (tenant_id = current_setting('app.tenant_id', true))
 WITH CHECK (tenant_id = current_setting('app.tenant_id', true));
GRANT SELECT, INSERT, UPDATE ON source_import_settings TO mascli_tenant;
