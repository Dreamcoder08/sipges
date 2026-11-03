import type { ParityCase } from '../types.ts';

/**
 * Synthetic rows of the audit context in DEFAULT_TENANT and OTHER_TENANT (see ../fixtures.ts),
 * with fixed timestamps (one with fractional seconds and one in another offset, to pin the
 * `ts` format). OTHER_TENANT's rows carry "AJENA" so a leak is plain in a mismatch report.
 * `/system/events` (a 240 s server-sent event stream) is not diffable and has no case here.
 */
export const seed = `
INSERT INTO audit (tenant_id, ts, module, record_id, action, detail) VALUES
  ('SIPGES/PRJ-SECHURA', '2026-01-02 03:04:05.678+00', 'Eventos', 'PARITY-E-1', 'CREATE', 'Alta sintética'),
  ('PARITY/OTRO',        '2026-01-02 03:04:06+00',     'Eventos', 'AJENA-1',    'CREATE', 'Fila AJENA'),
  ('SIPGES/PRJ-SECHURA', '2026-01-03 10:00:00-05',     'Riesgos', NULL,         'UPDATE', NULL),
  ('PARITY/OTRO',        '2026-01-03 11:00:00+00',     'Riesgos', 'AJENA-2',    'DELETE', 'Fila AJENA'),
  ('SIPGES/PRJ-SECHURA', '2026-01-04 00:00:00+00',     'SIPGES',  'PARITY-S-1', 'CONFIG', 'a <b> & "c"');
`;

export const cases: readonly ParityCase[] = [
  // The whole trail of the default project (newest first, no PARITY/OTRO row): equal to TS's.
  {
    name: 'audit: trail of the active project',
    method: 'GET',
    path: '/system/audit',
    auth: 'admin',
  },
  { name: 'audit: limit', method: 'GET', path: '/system/audit?limit=2', auth: 'admin' },
  { name: 'audit: limit 0', method: 'GET', path: '/system/audit?limit=0', auth: 'admin' },
  {
    name: 'audit: negative limit reads the ceiling',
    method: 'GET',
    path: '/system/audit?limit=-1',
    auth: 'admin',
  },
  {
    name: 'audit: limit above the ceiling',
    method: 'GET',
    path: '/system/audit?limit=100000',
    auth: 'admin',
  },
  {
    name: 'audit: limit with whitespace and sign',
    method: 'GET',
    path: '/system/audit?limit=%20%2B3%20',
    auth: 'admin',
  },
  { name: 'audit: invalid limit', method: 'GET', path: '/system/audit?limit=abc', auth: 'admin' },
  { name: 'audit: empty limit', method: 'GET', path: '/system/audit?limit=', auth: 'admin' },
  { name: 'audit: decimal limit', method: 'GET', path: '/system/audit?limit=2.5', auth: 'admin' },
  { name: 'audit: without a session', method: 'GET', path: '/system/audit' },
  { name: 'audit: read-only role', method: 'GET', path: '/system/audit', auth: 'consulta' },
  {
    name: 'audit: project without a grant',
    method: 'GET',
    path: '/system/audit',
    auth: 'admin',
    headers: { 'x-sipges-scope': 'PARITY/OTRO' },
  },
  {
    name: 'audit: query project_id of another project',
    method: 'GET',
    path: '/system/audit?project_id=OTRO',
    auth: 'admin',
  },
];
