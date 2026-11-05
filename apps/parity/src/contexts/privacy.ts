import type { ParityCase } from '../types.ts';

/**
 * The privacy context has no routes of its own, in TypeScript either: the guard sits inside MCP,
 * the narrator and embeddings, and its output is pinned byte for byte by
 * apps/api-go/internal/privacy/testdata. The one thing it reads that HTTP shows is the project's
 * «Envío a IA externa» switch, so these cases prove the switch of another project stays invisible:
 * it is on in OTHER_TENANT and off everywhere a session can read. The Go integration test covers a
 * switch that is on; `PUT /system/v4/settings` stays in TypeScript.
 */
const OTHER_TENANT = 'PARITY/OTRO'; // not imported: ../fixtures.ts reads these seeds
const PATH = '/system/v4/settings';
const route = 'privacy external AI switch';

export const cases: readonly ParityCase[] = [
  { name: `${route}: off in the active project`, method: 'GET', path: PATH, auth: 'admin' },
  { name: `${route}: read-only role`, method: 'GET', path: PATH, auth: 'consulta' },
  { name: `${route}: without a session`, method: 'GET', path: PATH },
  { name: `${route}: two projects need a choice`, method: 'GET', path: PATH, auth: 'multi' },
  {
    name: `${route}: another project stays invisible`,
    method: 'GET',
    path: PATH,
    auth: 'admin',
    headers: { 'x-sipges-scope': OTHER_TENANT },
  },
  {
    name: `${route}: query project_id of another project`,
    method: 'GET',
    path: `${PATH}?project_id=OTRO`,
    auth: 'admin',
  },
];

export const seed = `
INSERT INTO project_settings (tenant_id, settings, updated_by, updated_at) VALUES
  ('${OTHER_TENANT}', '{"externalAi":{"enabled":true}}'::jsonb, 'ajena', '2026-01-01T00:00:00Z')
  -- Another context's seed may insert this row first: merge into it.
  ON CONFLICT (tenant_id) DO UPDATE SET settings = project_settings.settings || EXCLUDED.settings;
`;
