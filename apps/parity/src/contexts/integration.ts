import type { ParityCase } from '../types.ts';

/**
 * Integration, admin reads only (T32): API key metadata, media feeds and the authorized-source
 * catalog. The seed loads keys, feeds and Defensoría settings in the default project and in
 * OTHER_TENANT (see ../fixtures.ts); the second project keeps none, so it answers the empty
 * state. `api_keys` has no row-level security: only the tenant filter keeps PARITY/OTRO's key,
 * which reuses a default-project key name, out. Feeds reuse ids across tenants, so only RLS
 * keeps them apart. Rows of the other project carry "AJENA" so a leak is plain in a mismatch
 * report. The hashes are synthetic placeholders: no answer may contain them.
 * Ids are explicit and every insert is ON CONFLICT DO NOTHING, so the seed does not depend on
 * other contexts' seeds or their order.
 */
export const seed = `
INSERT INTO api_keys (id, tenant_id, name, prefix, secret_hash, access, clearance, created_by,
  created_at, last_used_at, revoked_at) OVERRIDING SYSTEM VALUE VALUES
  (32001, 'SIPGES/PRJ-SECHURA', 'Zeta', 'c0ffee000001', 'hash-sintetico-1', 'read', 'limited',
   'parity', '2026-10-01 08:00:00.987+00', NULL, NULL),
  (32002, 'SIPGES/PRJ-SECHURA', 'Alfa', 'c0ffee000002', 'hash-sintetico-2', 'write', 'full',
   'parity', '2026-09-01 00:00:00+00', '2026-09-02 00:00:00+00', '2026-09-03 10:11:12.5+00'),
  (32003, 'SIPGES/PRJ-SECHURA', 'Beta', 'c0ffee000003', 'hash-sintetico-3', 'write', 'full',
   'parity', '2026-10-02 00:00:00+00', '2026-10-30 12:00:00.999+00', NULL),
  (32004, 'PARITY/OTRO', 'Zeta', 'c0ffee000004', 'hash-sintetico-4', 'write', 'full',
   'AJENA', '2026-10-01 00:00:00+00', NULL, NULL)
ON CONFLICT DO NOTHING;
INSERT INTO media_feeds (tenant_id, id, name, url, keywords, territory, authorization_note, enabled,
  updated_by, updated_at, last_poll_at, last_poll_error, last_imported, last_matched)
  OVERRIDING SYSTEM VALUE VALUES
  ('SIPGES/PRJ-SECHURA', 32002, 'Diario B', 'https://example.org/b.xml', '[]', '', 'Nota', false,
   'parity', '2026-10-03 00:00:00+00', NULL, '', 0, 0),
  ('SIPGES/PRJ-SECHURA', 32001, 'Diario A', 'https://example.org/a.xml?x=1&y=<2>',
   '["agua", "minería"]', 'Costa', 'Autorizado', true, 'parity', '2026-10-01 08:00:00.123456+00',
   '2026-10-02 09:30:00.5+00', 'La fuente no respondió a tiempo.', 3, 5),
  ('PARITY/OTRO', 32001, 'Diario AJENA', 'https://example.org/ajena.xml', '["AJENA"]', '', 'AJENA',
   true, 'AJENA', '2026-10-01 00:00:00+00', NULL, '', 0, 0)
ON CONFLICT DO NOTHING;
INSERT INTO source_import_settings (tenant_id, source_id, enabled, query, territory,
  authorization_note, revision, updated_by, updated_at, last_poll_at, last_poll_error,
  last_imported, last_duplicates) VALUES
  ('SIPGES/PRJ-SECHURA', 'defensoria', true, 'agua', 'Costa', 'Convenio sintético', 3, 'parity',
   '2026-10-04 05:06:07.089+00', '2026-10-05 00:00:00+00', 'source_poll_failed', 2, 1),
  ('PARITY/OTRO', 'defensoria', true, 'AJENA', 'AJENA', 'AJENA', 9, 'AJENA',
   '2026-10-01 00:00:00+00', NULL, '', 0, 0)
ON CONFLICT DO NOTHING;
`;

const API_KEYS = '/system/integrations/api-keys';

/** The cases every route shares: scope, session and project choice. */
const scoped = (label: string, path: string): ParityCase[] => [
  { name: `integration ${label}`, method: 'GET', path, auth: 'admin' },
  { name: `integration ${label} without a session`, method: 'GET', path },
  { name: `integration ${label} read-only role`, method: 'GET', path, auth: 'consulta' },
  {
    name: `integration ${label} of a project without a grant`,
    method: 'GET',
    path,
    auth: 'admin',
    headers: { 'x-sipges-scope': 'PARITY/PRJ-B' },
  },
  {
    name: `integration ${label} of the ungranted fixture project`,
    method: 'GET',
    path,
    auth: 'admin',
    headers: { 'x-sipges-scope': 'PARITY/OTRO' },
  },
  {
    name: `integration ${label} with project_id of another project`,
    method: 'GET',
    path: `${path}?project_id=OTRO`,
    auth: 'admin',
  },
  {
    name: `integration ${label} with project_id of its project`,
    method: 'GET',
    path: `${path}?project_id=PRJ-SECHURA`,
    auth: 'admin',
  },
  { name: `integration ${label} before choosing a project`, method: 'GET', path, auth: 'multi' },
  {
    name: `integration ${label} of the second project`,
    method: 'GET',
    path,
    auth: 'multi',
    headers: { 'x-sipges-scope': 'PARITY/PRJ-B' },
  },
  {
    name: `integration ${label} of the first project by a two-project user`,
    method: 'GET',
    path,
    auth: 'multi',
    headers: { 'x-sipges-scope': 'SIPGES/PRJ-SECHURA' },
  },
  {
    name: `integration ${label} with a trailing slash`,
    method: 'GET',
    path: `${path}/`,
    auth: 'admin',
  },
  { name: `integration ${label} HEAD`, method: 'HEAD', path, auth: 'admin' },
];

export const cases: readonly ParityCase[] = [
  // Admin only: consulta and the analista (multi) get the role gate's 403.
  ...scoped('api-keys', API_KEYS),
  ...scoped('media', '/system/v4/media'),
  ...scoped('sources', '/system/intelligence/sources'),
  {
    name: 'integration media feed write by the read-only role',
    method: 'POST',
    path: '/system/v4/media/feeds',
    auth: 'consulta',
    sameOrigin: true,
    body: { json: { name: 'Feed', url: 'https://example.org/f.xml', authorization_note: 'Nota' } },
  },
  {
    name: 'integration api-key revocation by an analyst',
    method: 'DELETE',
    path: `${API_KEYS}/32001`,
    auth: 'multi',
    sameOrigin: true,
    headers: { 'x-sipges-scope': 'SIPGES/PRJ-SECHURA' },
  },
];
