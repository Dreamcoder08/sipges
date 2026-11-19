// Test setup only: makes a synthetic SIPGES-like state folder with PGlite 0.5.15 itself.
//   node make-state.mjs <@electric-sql/pglite 0.5.15 dist folder> <state folder>
// Synthetic data only: every text value carries the marker ZZSECRET, which no output may show.
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

const [dist, state] = process.argv.slice(2);
if (!dist || !state) {
  console.error('usage: node make-state.mjs <pglite dist> <state folder>');
  process.exit(2);
}
const { PGlite } = await import(pathToFileURL(join(resolve(dist), 'index.js')).href);
const S = 'ZZSECRET';
await mkdir(join(state, 'uploads'), { recursive: true });
const db = new PGlite(join(state, 'pglite'));
await db.exec(`
CREATE ROLE sipges_tenant NOLOGIN NOINHERIT;
CREATE TABLE schema_migrations (version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now());
INSERT INTO schema_migrations (version, applied_at) VALUES ('0001_init', '2026-01-01T00:00:00Z'),
  ('0026_media_feeds', '2026-01-02T00:00:00Z');
CREATE TABLE tenants (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id text NOT NULL UNIQUE,
  label text NOT NULL,
  label_upper text GENERATED ALWAYS AS (upper(label)) STORED
);
COMMENT ON COLUMN tenants.label IS 'synthetic label';
CREATE TABLE module_records (
  tenant_id text NOT NULL REFERENCES tenants (tenant_id),
  id text NOT NULL,
  payload jsonb NOT NULL,
  marking text NOT NULL DEFAULT 'interno' CHECK (marking IN ('publico', 'interno', 'restringido')),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, id)
);
CREATE INDEX module_records_updated ON module_records (tenant_id, updated_at DESC);
ALTER TABLE module_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE module_records FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON module_records TO sipges_tenant
  USING (tenant_id = current_setting('app.tenant_id', true)
    AND (marking <> 'restringido' OR current_setting('app.clearance', true) = 'full'));
GRANT SELECT, INSERT, UPDATE ON module_records TO sipges_tenant;
GRANT SELECT ON tenants TO sipges_tenant;
CREATE SEQUENCE audit_id_seq START 100 INCREMENT 1;
CREATE TABLE audit (
  id bigint PRIMARY KEY DEFAULT nextval('audit_id_seq'),
  tenant_id text NOT NULL,
  ts timestamptz NOT NULL,
  action text NOT NULL,
  detail text
);
ALTER SEQUENCE audit_id_seq OWNED BY audit.id;
CREATE FUNCTION touch_updated_at() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END $$;
CREATE TRIGGER module_records_touch BEFORE UPDATE ON module_records
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
CREATE TABLE media_feeds (
  id integer PRIMARY KEY,
  url text NOT NULL CHECK (char_length(url) BETWEEN 9 AND 500 AND url LIKE 'https://%')
);
CREATE TABLE login_failures (username text, at timestamptz, n numeric(10,2), tags text[], v real[]);
CREATE VIEW record_counts AS SELECT tenant_id, count(*) AS n FROM module_records GROUP BY tenant_id;

INSERT INTO tenants (tenant_id, label) VALUES ('SIPGES/${S}-ALFA', '${S} Alfa'), ('SIPGES/${S}-BETA', '${S} Beta');
INSERT INTO module_records VALUES
  ('SIPGES/${S}-ALFA', '${S}-EV-1', '{"Titulo": "${S} reunión", "n": 1.5}', 'interno', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z'),
  ('SIPGES/${S}-ALFA', '${S}-EV-2', '{"Titulo": "${S} reservado"}', 'restringido', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z'),
  ('SIPGES/${S}-ALFA', '${S}-AC-1', '{"Nombre": "${S} ñandú\\nlínea"}', 'publico', '2026-01-01T00:00:00Z', '2026-02-03T04:05:06.789Z'),
  ('SIPGES/${S}-BETA', '${S}-CF-1', '{"Caso": "${S} beta"}', 'interno', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z');
INSERT INTO audit (tenant_id, ts, action, detail)
  SELECT 'SIPGES/${S}-ALFA', '2026-01-01T00:00:00Z'::timestamptz + g * interval '1 minute', 'create', '${S} ' || g
  FROM generate_series(1, 300) g;
INSERT INTO audit (tenant_id, ts, action, detail) VALUES ('SIPGES/${S}-BETA', '2026-01-01T00:00:00Z', 'login', NULL);
INSERT INTO media_feeds VALUES (1, 'https://${S}.example/feed');
INSERT INTO login_failures VALUES ('${S}-ana', '2026-01-01T00:00:00Z', 1.50, '{"${S} a","b"}', '{0.25,-1.5}'),
  ('${S}-ana', '2026-01-01T00:00:00Z', 1.50, '{"${S} a","b"}', '{0.25,-1.5}'), (NULL, NULL, NULL, NULL, NULL);
`);
await db.close();
await writeFile(join(state, 'data-key'), `${S}-data-key`);
await writeFile(join(state, 'admin-password'), `${S}-admin-password`);
