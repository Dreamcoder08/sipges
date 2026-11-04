import type { ParityCase } from '../types.ts';

/**
 * Indicators & IRSA, read-only (T23). The default project gets module records (one marked
 * 'restringido', which the read-only role must not count, one whose payload carries its own
 * `_id`, one of a module the indicators never read), a stored IRSA configuration with its bands
 * in a non-default order, a current phase with saved weights, and three snapshots. The second
 * project has none of them, so it answers with the defaults. OTHER_TENANT (see ../fixtures.ts)
 * holds rows of every kind marked "AJENA", under the same record ids, so only row-level
 * security keeps them out.
 */
export const seed = `
INSERT INTO module_records (tenant_id, module, id, payload, created_at, updated_at, marking) VALUES
  ('SIPGES/PRJ-SECHURA', 'Eventos', 'IND-EV-1',
   '{"Dimension_Principal": "Gobernanza", "Dimension_Secundaria": "Institucional",
     "Relevancia_Preliminar": "Alta", "Tipo_Evento": "Reunión comunal",
     "Descripcion_Hecho": "Conflicto por la representación ante la resolución registral",
     "_id": "id-del-payload"}', '2026-01-03 00:00:00+00', '2026-01-03 00:00:00+00', 'interno'),
  ('SIPGES/PRJ-SECHURA', 'Eventos', 'IND-EV-2',
   '{"Dimension_Principal": "Ambiental", "Relevancia_Preliminar": "Crítica",
     "Descripcion_Hecho": "Disputa por el uso del agua"}',
   '2026-01-04 00:00:00+00', '2026-01-04 00:00:00+00', 'restringido'),
  ('SIPGES/PRJ-SECHURA', 'Actores', 'IND-AC-1',
   '{"Tipo_Actor": "Comunal", "Rol/Relacion": "Representante",
     "Legitimidad/Representacion": "Fragmentada, pendiente de validar"}',
   '2026-01-03 00:00:00+00', '2026-01-03 00:00:00+00', 'interno'),
  ('SIPGES/PRJ-SECHURA', 'Alertas', 'IND-AL-1',
   '{"Dimension": "G", "Estado": "Abierta", "Nivel": "Alto"}',
   '2026-01-03 00:00:00+00', '2026-01-03 00:00:00+00', 'publico'),
  ('SIPGES/PRJ-SECHURA', 'Demandas', 'IND-DE-1',
   '{"Estado": "Pendiente", "Tema": "Empleo local", "Dimension": "Económica"}',
   '2026-01-03 00:00:00+00', '2026-01-03 00:00:00+00', 'interno'),
  ('SIPGES/PRJ-SECHURA', 'Compromisos', 'IND-CO-1',
   '{"Estado": "Vencido", "Descripcion": "Mesa técnica", "Fecha_Limite": "2025-12-01"}',
   '2026-01-03 00:00:00+00', '2026-01-03 00:00:00+00', 'interno'),
  ('SIPGES/PRJ-SECHURA', 'Narrativas', 'IND-NA-1',
   '{"Tema": "Tensión por la consulta previa", "Verificacion": "No verificada", "Alcance": 3}',
   '2026-01-03 00:00:00+00', '2026-01-03 00:00:00+00', 'interno'),
  ('SIPGES/PRJ-SECHURA', 'Otro_Modulo', 'IND-OT-1',
   '{"Estado": "Abierta", "Dimension": "G"}',
   '2026-01-03 00:00:00+00', '2026-01-03 00:00:00+00', 'interno'),
  ('PARITY/OTRO', 'Eventos', 'IND-EV-1',
   '{"Dimension_Principal": "Gobernanza", "Relevancia_Preliminar": "Crítica",
     "Descripcion_Hecho": "Conflicto AJENA"}', '2026-01-02 00:00:00+00', '2026-01-02 00:00:00+00', 'interno'),
  ('PARITY/OTRO', 'Alertas', 'AJENA-AL',
   '{"Dimension": "E", "Estado": "Abierta", "Nivel": "AJENA"}',
   '2026-01-02 00:00:00+00', '2026-01-02 00:00:00+00', 'interno');
INSERT INTO irsa_configs (tenant_id, config, updated_at) VALUES
  ('SIPGES/PRJ-SECHURA', '{"version":"0.4-indicators","weights":{"G":0.5,"A":0.1,"D":0.1,"N":0.1,"E":0.1,"I":0.1},"thresholds":{"Rojo":[60,100],"Naranja":[40,59.99],"Amarillo":[20,39.99],"Verde":[0,19.99]},"contributions":{"active_alert":10,"high_event":4},"extra":"conservado"}',
   '2026-01-03 00:00:00+00'),
  ('PARITY/OTRO', '{"version":"AJENA","weights":{"G":1},"thresholds":{"AJENA":[0,100]},"contributions":{}}',
   '2026-01-02 00:00:00+00');
INSERT INTO project_settings (tenant_id, settings, updated_by, updated_at) VALUES
  ('SIPGES/PRJ-SECHURA', '{"phase": "operacion", "phaseWeights": {"operacion": {"G": 0.3, "A": 0.1, "D": 0.2, "N": 0.1, "E": 0.2, "I": 0.1}, "cierre": {"G": 1}}}',
   'parity', '2026-01-03 00:00:00+00'),
  ('PARITY/OTRO', '{"phase": "cierre", "phaseWeights": {"cierre": {"E": 1}}}',
   'AJENA', '2026-01-02 00:00:00+00')
  -- Another context's seed (situations) may insert these rows first: merge into them. Both give
  -- each project the same phase, so the result does not depend on which seed runs first.
  ON CONFLICT (tenant_id) DO UPDATE SET settings = project_settings.settings || EXCLUDED.settings;
INSERT INTO irsa_snapshots (tenant_id, ts, irsa, level, scores, config_version, note) VALUES
  ('SIPGES/PRJ-SECHURA', '2026-01-05 10:00:00.789+00', 42.5, 'Amarillo', '{"G":40,"A":45.25}',
   '0.4-indicators', 'Corte de paridad'),
  ('PARITY/OTRO', '2026-01-06 00:00:00+00', 99.99, 'AJENA', '{"G":99.99}', 'AJENA', 'Corte AJENA'),
  ('SIPGES/PRJ-SECHURA', '2026-01-06 08:30:00+00', 61.75, 'Naranja', '{"G": 60.5, "A": 63}', NULL, NULL),
  ('SIPGES/PRJ-SECHURA', '2026-01-07 00:00:00+00', 12, 'Verde', '{}', '0.4-indicators', '');
`;

const ROUTES = [
  'irsa',
  'irsa/config',
  'irsa/history',
  'indicators',
  'model-status',
  'validation-template',
] as const;

export const cases: readonly ParityCase[] = [
  ...ROUTES.flatMap((route): ParityCase[] => {
    const path = `/system/${route}`;
    return [
      { name: `indicators ${route}`, method: 'GET', path, auth: 'admin' },
      { name: `indicators ${route} without a session`, method: 'GET', path },
      { name: `indicators ${route} read-only role`, method: 'GET', path, auth: 'consulta' },
      {
        name: `indicators ${route} of a project without a grant`,
        method: 'GET',
        path,
        auth: 'admin',
        headers: { 'x-sipges-scope': 'PARITY/PRJ-B' },
      },
      {
        name: `indicators ${route} of the ungranted fixture project`,
        method: 'GET',
        path,
        auth: 'multi',
        headers: { 'x-sipges-scope': 'PARITY/OTRO' },
      },
      {
        name: `indicators ${route} of the second project`,
        method: 'GET',
        path,
        auth: 'multi',
        headers: { 'x-sipges-scope': 'PARITY/PRJ-B' },
      },
      {
        name: `indicators ${route} of the first project by a two-project user`,
        method: 'GET',
        path,
        auth: 'multi',
        headers: { 'x-sipges-scope': 'SIPGES/PRJ-SECHURA' },
      },
    ];
  }),
  ...(['1', '-1', '', ' 2 ', '0x2', 'abc', '1.5', '1e400'] as const).map((limit): ParityCase => ({
    name: `indicators irsa/history with limit ${JSON.stringify(limit)}`,
    method: 'GET',
    path: `/system/irsa/history?limit=${encodeURIComponent(limit)}`,
    auth: 'admin',
  })),
  {
    name: 'indicators irsa/history with limit before the session check',
    method: 'GET',
    path: '/system/irsa/history?limit=abc',
  },
  {
    name: 'indicators irsa with a trailing slash',
    method: 'GET',
    path: '/system/irsa/',
    auth: 'admin',
  },
  ...writeCases(),
];

/**
 * The writes (T39). Both APIs receive each request at once against the same database, so a
 * configuration update must leave the same row whichever commits last, and each snapshot case
 * inserts two rows (their ids are normalized). The reads that follow show the persisted effect
 * through both APIs; the stored bytes themselves are pinned by the Go tests
 * (apps/api-go/internal/indicators). The last case restores the seeded configuration, so the
 * contexts after this one read it unchanged.
 */
function writeCases(): ParityCase[] {
  const config = '/system/irsa/config';
  const snapshot = '/system/irsa/snapshot';
  const patch = {
    payload: {
      weights: { I: 0.2, G: 0.4, A: 0.1, D: 0.1, N: 0.1, E: 0.1 },
      thresholds: { Rojo: [70, 100], Amarillo: [30, 69.99], '2': [0, 29.99] },
      contributions: { high_event: 6 },
      version: 'ignorado',
    },
  };
  const write = (
    name: string,
    path: string,
    body: NonNullable<ParityCase['body']>,
    extra: Partial<ParityCase> = {},
    drop: readonly ('auth' | 'sameOrigin')[] = [],
  ): ParityCase => {
    const { auth = 'admin', sameOrigin = true, ...rest } = extra;
    return {
      name: `indicators ${name}`,
      method: 'POST',
      path,
      body,
      ...rest,
      ...(drop.includes('auth') ? {} : { auth }),
      ...(drop.includes('sameOrigin') ? {} : { sameOrigin }),
    };
  };
  const read = (name: string, path: string, extra: Partial<ParityCase> = {}) =>
    ({ name: `indicators ${name}`, method: 'GET', path, auth: 'admin', ...extra }) as ParityCase;
  const otherProjects: Partial<ParityCase>[] = [
    { headers: { 'x-sipges-scope': 'PARITY/PRJ-B' } },
    { auth: 'multi', headers: { 'x-sipges-scope': 'PARITY/OTRO' } },
  ];
  const gates = (
    path: string,
    label: string,
    body: NonNullable<ParityCase['body']>,
  ): ParityCase[] => [
    write(`${label} write without a session`, path, body, {}, ['auth']),
    write(`${label} write without an Origin`, path, body, {}, ['sameOrigin']),
    write(`${label} write by the read-only role`, path, body, { auth: 'consulta' }),
    write(`${label} write by a two-project user before choosing`, path, body, { auth: 'multi' }),
    ...otherProjects.map((extra, i) =>
      write(`${label} write into an ungranted project ${i + 1}`, path, body, extra),
    ),
    write(`${label} write naming another project in the body`, path, {
      json: { project_id: 'PARITY/OTRO', payload: {} },
    }),
    write(`${label} write naming another project in the payload`, path, {
      json: { payload: { project_id: 'PARITY/PRJ-B' } },
    }),
    write(
      `${label} write with a query project_id of another project`,
      `${path}?project_id=PARITY%2FOTRO`,
      body,
    ),
    write(`${label} write with a trailing slash`, `${path}/`, body),
    write(`${label} write that is not JSON`, path, { raw: '{"payload":' }),
    write(`${label} write with an empty body`, path, { raw: '' }),
    write(`${label} write that is an array`, path, { json: [1] }),
    write(`${label} write without a payload`, path, { json: {} }),
    write(`${label} write with a null payload`, path, { json: { payload: null } }),
  ];
  const seeded = {
    payload: {
      weights: { G: 0.5, A: 0.1, D: 0.1, N: 0.1, E: 0.1, I: 0.1 },
      thresholds: {
        Rojo: [60, 100],
        Naranja: [40, 59.99],
        Amarillo: [20, 39.99],
        Verde: [0, 19.99],
      },
      contributions: { active_alert: 10, high_event: 4 },
    },
  };
  return [
    // POST /system/irsa/config: admin only.
    write('irsa/config update', config, { json: patch }),
    read('irsa/config after the update', config),
    read('irsa/config after the update, read-only role', config, { auth: 'consulta' }),
    read('irsa after the configuration update', '/system/irsa'),
    write('irsa/config update repeated', config, { json: patch }),
    read('irsa/config after the repeated update', config),
    write('irsa/config with weights outside the tolerance', config, {
      json: { payload: { weights: { G: 0.9 } } },
    }),
    write('irsa/config with an empty weights object', config, {
      json: { payload: { weights: {} } },
    }),
    write('irsa/config with an empty payload', config, { json: { payload: {} } }),
    write('irsa/config with a BOM', config, {
      raw: '\ufeff{"payload":{"contributions":{"high_event":6}}}',
    }),
    write('irsa/config with duplicate and __proto__ keys', config, {
      raw: '{"payload":{"contributions":{"high_event":5,"__proto__":1,"high_event":6}}}',
    }),
    write('irsa/config with values of the wrong types', config, {
      raw: '{"payload":{"weights":{"b":"x","1":"y","G":true,"A":1e400},"thresholds":{"A":[1],"B":[1,2,3],"C":["1",null],"D":{}},"contributions":[]}}',
    }),
    write('irsa/config with null records', config, {
      json: { payload: { weights: null, thresholds: null, contributions: null } },
    }),
    read('irsa/config after the refused updates', config),
    ...gates(config, 'irsa/config', { json: patch }),
    read('irsa/config after the refused writes', config),
    read('irsa/config of the second project after the refused writes', config, {
      auth: 'multi',
      headers: { 'x-sipges-scope': 'PARITY/PRJ-B' },
    }),
    // POST /system/irsa/snapshot: any role that may write.
    write(
      'irsa/snapshot with a note',
      snapshot,
      { json: { payload: { note: 'Corte de paridad (escritura)' } } },
      {
        normalize: ['id'],
      },
    ),
    write(
      'irsa/snapshot repeated',
      snapshot,
      { json: { payload: { note: 'Corte de paridad (escritura)' } } },
      {
        normalize: ['id'],
      },
    ),
    write(
      'irsa/snapshot with an object note',
      snapshot,
      { json: { payload: { note: { b: 1, '2': [true, null] } } } },
      {
        normalize: ['id'],
      },
    ),
    write(
      'irsa/snapshot with a falsy note',
      snapshot,
      { json: { payload: { note: 0 } } },
      { normalize: ['id'] },
    ),
    write(
      'irsa/snapshot by a two-project user in the second project',
      snapshot,
      { json: { payload: {} } },
      {
        auth: 'multi',
        headers: { 'x-sipges-scope': 'PARITY/PRJ-B' },
        normalize: ['id'],
      },
    ),
    write(
      'irsa/snapshot by a two-project user in the first project',
      snapshot,
      { json: { payload: { note: 'multi' } } },
      {
        auth: 'multi',
        headers: { 'x-sipges-scope': 'SIPGES/PRJ-SECHURA' },
        normalize: ['id'],
      },
    ),
    read('irsa/history after the snapshots', '/system/irsa/history?limit=20'),
    read('irsa/history of the second project after the snapshots', '/system/irsa/history', {
      auth: 'multi',
      headers: { 'x-sipges-scope': 'PARITY/PRJ-B' },
    }),
    read('irsa/history after the snapshots, read-only role', '/system/irsa/history?limit=20', {
      auth: 'consulta',
    }),
    write('irsa/snapshot with a NUL note', snapshot, { json: { payload: { note: 'a\u0000b' } } }),
    write('irsa/snapshot with a NUL inside an array note', snapshot, {
      json: { payload: { note: [null, ['x\u0000']] } },
    }),
    write('irsa/snapshot with a number payload', snapshot, { json: { payload: 1 } }),
    ...gates(snapshot, 'irsa/snapshot', { json: { payload: { note: 'rechazado' } } }),
    read('irsa/history after the refused snapshots', '/system/irsa/history?limit=20'),
    // Back to the seeded configuration for the contexts that follow.
    write('irsa/config restored', config, { json: seeded }),
    read('irsa/config after the restore', config),
  ];
}
