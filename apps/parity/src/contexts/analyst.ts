import type { ParityCase } from '../types.ts';

/**
 * Analyst, deterministic reads (T30): GET /system/briefing (the extractive briefing; this stage of
 * the parity run configures no narrator, ../assisted-briefing.ts does) and GET
 * /system/briefing/proposals. The seed is a small graph in
 * the default project, with explicit and inferred links, a restricted source (hidden from
 * `consulta`), an overdue commitment, open severe alerts (one already decided), a demand answered
 * by a commitment and a narrative naming an actor in its text. OTHER_TENANT (see ../fixtures.ts)
 * reuses every id with "AJENA" in the text and leaves its alert undecided, so a cross-tenant read
 * shows as a difference. Ids are prefixed PARITY-AN- and inserts skip rows that already exist, so
 * the seed does not depend on any other context's.
 */

const SECHURA = 'SIPGES/PRJ-SECHURA';
const OTHER = 'PARITY/OTRO';

const quoted = (value: string) => `'${value.replaceAll("'", "''")}'`;

const graph = (tenant: string, word: string) => {
  const row = (
    module: string,
    id: string,
    payload: Readonly<Record<string, string>>,
    marking: string,
    updated: string,
  ) =>
    `(${quoted(tenant)}, ${quoted(module)}, ${quoted(id)}, ${quoted(
      JSON.stringify(payload).replaceAll('WORD', word),
    )}::jsonb, ${quoted(marking)}, '2026-01-01T00:00:00Z', ${quoted(updated)})`;
  const rows = [
    row(
      'Actores',
      'PARITY-AN-A1',
      {
        'Nombre_Actor/Organizacion': 'Colectivo WORD',
        Posicion_Proyecto: 'En contra',
        Territorio: 'Bahía',
      },
      'interno',
      '2026-02-01T00:00:00Z',
    ),
    row(
      'Actores',
      'PARITY-AN-A2',
      { 'Nombre_Actor/Organizacion': 'Gremio WORD', Posicion_Proyecto: 'A favor' },
      'interno',
      '2026-02-02T00:00:00Z',
    ),
    row(
      'Eventos',
      'PARITY-AN-EV1',
      {
        Descripcion_Hecho: 'Asamblea   WORD en la bahía',
        Fecha: '2026-03-01',
        Actor_Principal: ' colectivo WORD ',
        Fuente_ID: 'PARITY-AN-F1',
        Tipo_Evento: 'Reunión',
      },
      'interno',
      '2026-02-03T00:00:00Z',
    ),
    row(
      'Fuentes',
      'PARITY-AN-F1',
      { Archivo_Fuente: 'Acta WORD', Fecha_Documento: '2026-03-02' },
      'publico',
      '2026-02-04T00:00:00Z',
    ),
    row(
      'Fuentes',
      'PARITY-AN-F2',
      { Archivo_Fuente: 'Informe reservado WORD' },
      'restringido',
      '2026-02-05T00:00:00Z',
    ),
    row(
      'Alertas',
      'PARITY-AN-AL1',
      {
        Causa: 'Amenaza de paro WORD',
        Nivel_Preliminar: 'Crítica',
        Estado: 'Abierta',
        Fecha: '2026-03-03',
      },
      'interno',
      '2026-02-06T00:00:00Z',
    ),
    row(
      'Alertas',
      'PARITY-AN-AL2',
      { Causa: 'Bloqueo de vía WORD', Nivel_Preliminar: 'Roja', Estado: 'En curso' },
      'interno',
      '2026-02-07T00:00:00Z',
    ),
    row(
      'Alertas',
      'PARITY-AN-AL3',
      { Causa: 'Rumor WORD', Nivel_Preliminar: 'Alta', Estado: 'Cerrada' },
      'interno',
      '2026-02-08T00:00:00Z',
    ),
    row(
      'Demandas',
      'PARITY-AN-D1',
      {
        Descripcion: 'Piden agua WORD',
        Prioridad: 'Urgente',
        Estado: 'Abierta',
        'Actor/Grupo': 'Gremio WORD',
      },
      'interno',
      '2026-02-09T00:00:00Z',
    ),
    row(
      'Demandas',
      'PARITY-AN-D2',
      { Descripcion: 'Piden empleo WORD', Prioridad: 'Alta', Estado: 'Pendiente' },
      'interno',
      '2026-02-10T00:00:00Z',
    ),
    row(
      'Compromisos',
      'PARITY-AN-C1',
      {
        Descripcion: 'Cisternas WORD',
        'Actor/Entidad': 'Colectivo WORD',
        Demanda_Asociada: 'PARITY-AN-D1',
        Plazo: '2026-01-15',
        Estado: 'Pendiente',
        'Avance_%': '10',
      },
      'interno',
      '2026-02-11T00:00:00Z',
    ),
    row(
      'Narrativas',
      'PARITY-AN-N1',
      {
        Descripcion:
          'En la radio, el Colectivo WORD   pidió diálogo; también habló el gremio WORD.',
        Fecha_Observacion: '2026-03-04',
        Tono: 'Crítico',
      },
      'interno',
      '2026-02-12T00:00:00Z',
    ),
    row(
      'Acciones',
      'PARITY-AN-AC1',
      {
        Accion: 'Mesa con el Colectivo WORD',
        Alerta_Asociada: 'PARITY-AN-AL2',
        Estado: 'Pendiente',
      },
      'interno',
      '2026-02-13T00:00:00Z',
    ),
  ];
  const link = (type: string, from: [string, string], to: [string, string]) =>
    `(${quoted(tenant)}, ${quoted(type)}, ${quoted(from[0])}, ${quoted(from[1])}, ${quoted(to[0])}, ${quoted(
      to[1],
    )}, '', 'sistema', '2026-02-20T00:00:00Z')`;
  const links = [
    link('relacionado_con', ['Actores', 'PARITY-AN-A1'], ['Fuentes', 'PARITY-AN-F2']),
    link('en_conflicto_con', ['Actores', 'PARITY-AN-A2'], ['Actores', 'PARITY-AN-A1']),
    // Also inferred from the event's Actor_Principal: the explicit copy wins.
    link('participa_en', ['Actores', 'PARITY-AN-A1'], ['Eventos', 'PARITY-AN-EV1']),
  ];
  return `INSERT INTO module_records (tenant_id, module, id, payload, marking, created_at, updated_at) VALUES
  ${rows.join(',\n  ')}
  ON CONFLICT DO NOTHING;
INSERT INTO record_links (tenant_id, link_type, source_module, source_id, target_module, target_id, note,
  created_by, created_at) VALUES
  ${links.join(',\n  ')}
  ON CONFLICT DO NOTHING;`;
};

export const seed = `
${graph(SECHURA, 'Bahía')}
${graph(OTHER, 'AJENA')}
INSERT INTO proposal_decisions (tenant_id, fingerprint, subject_module, subject_id, kind, decision,
  decided_by, decided_at) VALUES
  ('${SECHURA}', 'record:compromisos:demandas/PARITY-AN-D2', 'demandas', 'PARITY-AN-D2', 'record', 'rejected',
   'admin', '2026-02-21T00:00:00Z')
  ON CONFLICT DO NOTHING;
`;

type Route = {
  readonly name: string;
  readonly path: string;
  readonly normalize?: readonly string[];
};

const ROUTES: readonly Route[] = [
  { name: 'briefing', path: '/system/briefing', normalize: ['generated_at'] },
  { name: 'briefing proposals', path: '/system/briefing/proposals' },
];

const SUBJECTS = [
  'module=actores&id=PARITY-AN-A1',
  'module=actores&id=PARITY-AN-A2',
  'module=eventos&id=PARITY-AN-EV1',
  'module=fuentes&id=PARITY-AN-F1',
  'module=fuentes&id=PARITY-AN-F2',
  'module=alertas&id=PARITY-AN-AL1',
  'module=alertas&id=PARITY-AN-AL2',
  'module=alertas&id=PARITY-AN-AL3',
  'module=demandas&id=PARITY-AN-D1',
  'module=demandas&id=PARITY-AN-D2',
  'module=compromisos&id=PARITY-AN-C1',
  'module=narrativas&id=PARITY-AN-N1',
  'module=acciones&id=PARITY-AN-AC1',
];

/** Each answers 404 "Registro no encontrado" on both APIs. */
const NOT_FOUND = [
  ['no query', ''],
  ['no id', '?module=actores'],
  ['no module', '?id=PARITY-AN-A1'],
  ['an unknown module', '?module=nada&id=PARITY-AN-A1'],
  ['the module name instead of its slug', '?module=Actores&id=PARITY-AN-A1'],
  ['an unknown id', '?module=actores&id=PARITY-AN-NADA'],
  ['an id over 200 characters', `?module=actores&id=${'x'.repeat(201)}`],
  ['an id with a NUL', '?module=actores&id=PARITY-AN-A1%00'],
  ['a repeated key (first wins)', '?module=nada&module=actores&id=PARITY-AN-A1'],
] as const;

const OWN = '?module=actores&id=PARITY-AN-A1';

const routeCases = ROUTES.flatMap(({ name, path, normalize }): ParityCase[] => {
  const n = normalize ? { normalize } : {};
  return [
    ...SUBJECTS.map((query): ParityCase => ({
      name: `analyst ${name} ${query}`,
      method: 'GET',
      path: `${path}?${query}`,
      auth: 'admin',
      ...n,
    })),
    ...SUBJECTS.map((query): ParityCase => ({
      name: `analyst ${name} ${query} read-only role`,
      method: 'GET',
      path: `${path}?${query}`,
      auth: 'consulta',
      ...n,
    })),
    ...NOT_FOUND.map(([label, query]): ParityCase => ({
      name: `analyst ${name} with ${label}`,
      method: 'GET',
      path: `${path}${query}`,
      auth: 'admin',
    })),
    { name: `analyst ${name} without a session`, method: 'GET', path: `${path}${OWN}` },
    {
      name: `analyst ${name} with an unknown session`,
      method: 'GET',
      path: `${path}${OWN}`,
      headers: { cookie: `sipges_session=${'0'.repeat(64)}` },
    },
    {
      name: `analyst ${name} of a project without a grant`,
      method: 'GET',
      path: `${path}${OWN}`,
      auth: 'admin',
      headers: { 'x-sipges-scope': 'PARITY/PRJ-B' },
    },
    {
      name: `analyst ${name} of the ungranted fixture project`,
      method: 'GET',
      path: `${path}${OWN}`,
      auth: 'multi',
      headers: { 'x-sipges-scope': 'PARITY/OTRO' },
    },
    {
      name: `analyst ${name} with project_id of another project`,
      method: 'GET',
      path: `${path}${OWN}&project_id=PRJ-B`,
      auth: 'admin',
    },
    {
      name: `analyst ${name} with project_id of its project`,
      method: 'GET',
      path: `${path}${OWN}&project_id=PRJ-SECHURA`,
      auth: 'admin',
      ...n,
    },
    {
      name: `analyst ${name} before choosing a project`,
      method: 'GET',
      path: `${path}${OWN}`,
      auth: 'multi',
    },
    {
      // The record exists in the default project and in OTHER_TENANT, not here: 404.
      name: `analyst ${name} of the second project`,
      method: 'GET',
      path: `${path}${OWN}`,
      auth: 'multi',
      headers: { 'x-sipges-scope': 'PARITY/PRJ-B' },
    },
    {
      name: `analyst ${name} of the first project by a two-project user`,
      method: 'GET',
      path: `${path}${OWN}`,
      auth: 'multi',
      headers: { 'x-sipges-scope': 'SIPGES/PRJ-SECHURA' },
      ...n,
    },
    {
      name: `analyst ${name} with a trailing slash`,
      method: 'GET',
      path: `${path}/${OWN}`,
      auth: 'admin',
    },
    { name: `analyst ${name} HEAD`, method: 'HEAD', path: `${path}${OWN}`, auth: 'admin' },
  ];
});

export const cases: readonly ParityCase[] = [
  ...routeCases,
  {
    // Deciding stays in TypeScript; the read-only role is refused before any route in both APIs.
    name: 'analyst proposal decision by the read-only role',
    method: 'POST',
    path: '/system/briefing/proposals',
    auth: 'consulta',
    sameOrigin: true,
    body: {
      json: {
        module: 'alertas',
        id: 'PARITY-AN-AL1',
        fingerprint: 'record:acciones:alertas/PARITY-AN-AL1',
        decision: 'reject',
      },
    },
  },
];
