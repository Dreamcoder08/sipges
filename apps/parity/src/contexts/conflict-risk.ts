import type { ParityCase } from '../types.ts';

/**
 * GET /system/conflict-risk (ADR 0031). The Rust engine is pinned by engines/fixtures; these cases
 * pin what the route feeds it: the scope's dated records, territorial alerts and IRSA history. A
 * record marked 'restringido' must not reach the read-only role, and PARITY/OTRO's rows carry
 * "AJENA" so a leak is plain in a mismatch report.
 */
const SECHURA = 'SIPGES/PRJ-SECHURA';
const OTHER = 'PARITY/OTRO';

type Row = readonly [module: string, id: string, payload: object, at: string, marking?: string];

/** An emoji across the 117-unit title cut: both APIs drop its broken half. */
const SPLIT_TITLE = `${'a'.repeat(116)}😀${'b'.repeat(20)}`;

const ROWS: readonly Row[] = [
  [
    'Demandas',
    'CR-D-2',
    {
      Territorio: 'Caleta Riesgo',
      Tema: SPLIT_TITLE,
      Estado: 'Abierta',
      Fecha_Registro: '2026-10-03',
    },
    '2026-10-03 12:00:00+00',
  ],
  [
    'Demandas',
    'CR-D-1',
    {
      Territorio: 'Caleta Riesgo',
      Tema: 'Agua',
      Estado: 'Abierta',
      Prioridad: 'Alta',
      Fecha_Registro: '2026-10-01',
      'Actor/Grupo': 'Comité Riesgo',
    },
    '2026-10-01 12:00:00+00',
  ],
  [
    'Compromisos',
    'CR-C-1',
    {
      Territorio: 'Caleta Riesgo',
      Descripcion: 'Entrega de obra',
      Estado: 'Pendiente',
      Fecha: '2026-09-15',
      'Actor/Entidad': 'Empresa Riesgo',
    },
    '2026-09-01 12:00:00.250+00',
  ],
  [
    'Narrativas',
    'CR-N-1',
    {
      Territorio: 'Bahía Ñandú',
      Tema: 'Rechazo',
      Tono: 'Crítico',
      Actor_Relacionado: 'Comité Riesgo',
      Fecha_Inicio: '2026-10-10',
    },
    '2026-10-10 12:00:00+00',
  ],
  [
    'Alertas',
    'CR-A-1',
    {
      Territorio: 'Caleta Riesgo',
      Nivel_Preliminar: 'Rojo',
      Estado: 'Activa',
      Fecha: '2026-08-20',
    },
    '2026-08-20 12:00:00+00',
  ],
  [
    'Alertas',
    'CR-A-2',
    {
      Territorio: 'Zona Riesgo Reservada',
      Nivel_Preliminar: 'Naranja',
      Estado: 'Activa',
      Fecha: '2026-10-05',
    },
    '2026-10-05 12:00:00+00',
    'restringido',
  ],
  [
    'Eventos',
    'CR-E-1',
    {
      Territorio: 'Bahía Ñandú',
      Nivel_Preliminar: 'Alto',
      Descripcion_Hecho: 'Bloqueo',
      Fecha: '2026-07-01',
    },
    '2026-07-01 12:00:00+00',
  ],
];

const OTHER_ROWS: readonly Row[] = [
  [
    'Alertas',
    'CR-AJENA-1',
    {
      Territorio: 'Territorio AJENA',
      Nivel_Preliminar: 'Rojo',
      Estado: 'Activa',
      Fecha: '2026-10-01',
    },
    '2026-10-01 12:00:00+00',
  ],
];

const quote = (value: string) => `'${value.replaceAll("'", "''")}'`;

const insert = (tenant: string, rows: readonly Row[]) =>
  rows
    .map(
      ([module, id, payload, at, marking = 'interno']) =>
        `(${[tenant, module, id, JSON.stringify(payload), at, at, marking].map(quote).join(', ')})`,
    )
    .join(',\n  ');

const alert = (
  tenant: string,
  project: string,
  id: string,
  at: string,
  territory: string,
  level: string,
  status: string,
) =>
  `(${[tenant, id, project, at, 'https://example.org/riesgo', 'sintetico', 'Extracto', 'a'.repeat(64), level, status, territory].map(quote).join(', ')}, 10, 'reglas', '[]', '[]', '[]', false, '')`;

export const seed = `
INSERT INTO module_records (tenant_id, module, id, payload, created_at, updated_at, marking) VALUES
  ${insert(SECHURA, ROWS)},
  ${insert(OTHER, OTHER_ROWS)};
INSERT INTO digital_alert_reviews (tenant_id, id, project_id, created_at, source_url, source_type, excerpt, sha256,
  level, status, territory, score, method, themes, signals, suggestions, semantic_active, analyst_note) VALUES
  ${alert(SECHURA, 'PRJ-SECHURA', 'CR-TA-1', '2026-10-02 08:00:00.5+00', 'Caleta Riesgo', 'Alta', 'Pendiente de verificación')},
  ${alert(SECHURA, 'PRJ-SECHURA', 'CR-TA-2', '2026-09-02 08:00:00+00', 'Bahía Ñandú', 'Media', 'Descartado')},
  ${alert(OTHER, 'OTRO', 'CR-TA-AJENA', '2026-10-02 08:00:00+00', 'Territorio AJENA', 'Alta', 'Pendiente de verificación')};
INSERT INTO irsa_snapshots (tenant_id, ts, irsa, level, scores, config_version, note) VALUES
  (${quote(SECHURA)}, '2026-08-01 10:00:00+00', 35.25, 'Amarillo', '{}', NULL, NULL),
  (${quote(SECHURA)}, '2026-10-20 10:00:00+00', 48.5, 'Naranja', '{}', NULL, NULL);
`;

const path = '/system/conflict-risk';

export const cases: readonly ParityCase[] = [
  {
    name: 'conflict risk',
    method: 'GET',
    path,
    auth: 'admin',
    present: ['Caleta Riesgo', 'Zona Riesgo Reservada', `${'a'.repeat(116)}…`],
    absent: ['AJENA'],
  },
  {
    name: 'conflict risk read-only role',
    method: 'GET',
    path,
    auth: 'consulta',
    present: ['Caleta Riesgo'],
    absent: ['AJENA', 'Zona Riesgo Reservada'],
  },
  { name: 'conflict risk without a session', method: 'GET', path },
  {
    name: 'conflict risk with an unknown session',
    method: 'GET',
    path,
    headers: { cookie: `sipges_session=${'0'.repeat(64)}` },
  },
  {
    name: 'conflict risk of a project without a grant',
    method: 'GET',
    path,
    auth: 'admin',
    headers: { 'x-sipges-scope': 'PARITY/PRJ-B' },
  },
  {
    name: 'conflict risk of the ungranted fixture project',
    method: 'GET',
    path,
    auth: 'multi',
    headers: { 'x-sipges-scope': 'PARITY/OTRO' },
  },
  {
    name: 'conflict risk with project_id of another project',
    method: 'GET',
    path: `${path}?project_id=PRJ-B`,
    auth: 'admin',
  },
  {
    name: 'conflict risk with project_id of its project',
    method: 'GET',
    path: `${path}?project_id=PRJ-SECHURA`,
    auth: 'admin',
  },
  { name: 'conflict risk before choosing a project', method: 'GET', path, auth: 'multi' },
  {
    name: 'conflict risk of the second project, with no signals',
    method: 'GET',
    path,
    auth: 'multi',
    headers: { 'x-sipges-scope': 'PARITY/PRJ-B' },
  },
  {
    name: 'conflict risk of the first project by a two-project user',
    method: 'GET',
    path,
    auth: 'multi',
    headers: { 'x-sipges-scope': 'SIPGES/PRJ-SECHURA' },
  },
  { name: 'conflict risk with a trailing slash', method: 'GET', path: `${path}/`, auth: 'admin' },
  { name: 'conflict risk HEAD', method: 'HEAD', path, auth: 'admin' },
  { name: 'conflict risk POST', method: 'POST', path, auth: 'admin', sameOrigin: true },
];
