import type { ParityCase } from '../types.ts';

/**
 * Ontology (T26 reads, T38 writes): GET /system/ontology, /system/search, /system/timeline,
 * /system/links and /system/graph; POST /system/graph/neighbourhood; and the writes POST
 * /system/links, PUT /system/links/:id/evidence, PUT /system/marking, DELETE /system/links/:id
 * (see WRITES below). The seed adds records and links in the default project and,
 * with the same ids, in OTHER_TENANT (see ../fixtures.ts), so only row-level security keeps the
 * second set out; its texts carry "AJENA", so a leak is plain in a mismatch report. Every record
 * holds the word "ontoparidad", which no other context's seed uses, so searches read only these
 * rows whatever the other seeds hold. Ids are prefixed PARITY-ONT- and inserts skip rows that
 * already exist, so the seed does not depend on the order of the other contexts' seeds.
 *
 * The default project's records cover: an accented title (search folding), a title cut inside
 * an emoji (lone surrogate in JSON), numbers and booleans where text is expected, a record marked
 * 'restringido' (hidden from `consulta`, also as a link end), explicit links with evidence that
 * is available and one whose source is missing, and links inferred by id and by title.
 */

const SECHURA = 'SIPGES/PRJ-SECHURA';
const OTHER = 'PARITY/OTRO';

const quote = (value: string) => `'${value.replaceAll("'", "''")}'`;

/** A text value, or a SQL expression. */
type Value = string | { readonly sql: string };
const literal = (value: Value) => (typeof value === 'object' ? value.sql : quote(value));

const record = (
  tenant: string,
  module: string,
  id: string,
  fields: Readonly<Record<string, Value>>,
  marking = 'interno',
  updated = '2026-01-01T00:00:00Z',
) => {
  const pairs = Object.entries(fields).map(([key, value]) => `${quote(key)}, ${literal(value)}`);
  return `(${quote(tenant)}, ${quote(module)}, ${quote(id)}, jsonb_build_object(${pairs.join(', ')}),
    ${quote(marking)}, '2026-01-01T00:00:00Z', ${quote(updated)})`;
};

const records = (tenant: string, tag: string) => [
  record(tenant, 'Actores', 'PARITY-ONT-A1', {
    'Nombre_Actor/Organizacion': `Asociación Ontoparidad Ñandú${tag}`,
    Tipo_Actor: 'Organización',
    Influencia: { sql: '3' },
    Territorio: 'Sechura',
    Activo: { sql: 'true' },
  }),
  record(tenant, 'Actores', 'PARITY-ONT-A2', {
    'Nombre_Actor/Organizacion': `Frente ontoparidad del río${tag}`,
    Posicion_Proyecto: { sql: '1.50' },
  }),
  record(
    tenant,
    'Eventos',
    'PARITY-ONT-E1',
    {
      Descripcion_Hecho: {
        sql: `repeat('ontoparidad ', 11) || 'xxxxxx' || '😀 y el agua sigue${tag}'`,
      },
      Fecha: '2025-03-04',
      Tipo_Evento: 'Reunión',
      Actor_Principal: `  asociación ontoparidad ñandú${tag}  `,
      Fuente_ID: 'PARITY-ONT-F1',
    },
    'interno',
    '2026-01-03T00:00:00Z',
  ),
  record(tenant, 'Fuentes', 'PARITY-ONT-F1', {
    Archivo_Fuente: `acta-ontoparidad${tag}.pdf`,
    Fecha_Documento: '2025-03-05T10:00:00Z',
    Tipo_Fuente: 'Acta',
  }),
  record(
    tenant,
    'Alertas',
    'PARITY-ONT-AL1',
    { Causa: `Alerta ontoparidad reservada${tag}`, Fecha: '2025-03-06', Estado: 'Abierta' },
    'restringido',
  ),
  record(tenant, 'Acciones', 'PARITY-ONT-AC1', {
    Accion: `Acción ontoparidad${tag}`,
    Alerta_Asociada: 'PARITY-ONT-AL1',
    Responsable: 'Equipo',
  }),
  record(tenant, 'Demandas', 'PARITY-ONT-D1', {
    Descripcion: `Demanda de agua${tag}`,
    Fecha_Registro: '2025-02',
    'Actor/Grupo': `Frente ontoparidad del río${tag}`,
    Nota: {
      sql: `repeat('relleno ', 10) || 'ONTOPARIDAD en una nota larga que sigue más allá del extracto'`,
    },
  }),
  record(
    tenant,
    'Lecciones_Territoriales',
    'PARITY-ONT-L1',
    { Aprendido: `Lección ontoparidad${tag}`, Fecha: '2024-12-31', Territorio: 'Vice' },
    'publico',
  ),
];

const link = (
  tenant: string,
  type: string,
  source: readonly [string, string],
  target: readonly [string, string],
  note: string,
  evidence: string | null,
) =>
  `(${quote(tenant)}, ${quote(type)}, ${quote(source[0])}, ${quote(source[1])}, ${quote(target[0])},
    ${quote(target[1])}, ${quote(note)}, 'parity', '2025-03-07T08:09:10.789Z', ${evidence ? quote(evidence) : 'NULL'})`;

const links = (tenant: string, tag: string) => [
  link(
    tenant,
    'aliado_de',
    ['Actores', 'PARITY-ONT-A1'],
    ['Actores', 'PARITY-ONT-A2'],
    `Alianza${tag}`,
    'PARITY-ONT-F1',
  ),
  link(tenant, 'origina', ['Eventos', 'PARITY-ONT-E1'], ['Alertas', 'PARITY-ONT-AL1'], '', null),
  link(
    tenant,
    'relacionado_con',
    ['Demandas', 'PARITY-ONT-D1'],
    ['Eventos', 'PARITY-ONT-E1'],
    '',
    'PARITY-ONT-NOPE',
  ),
  link(
    tenant,
    'relacionado_con',
    ['Lecciones_Territoriales', 'PARITY-ONT-L1'],
    ['Actores', 'PARITY-ONT-A2'],
    '',
    null,
  ),
];

/**
 * The writes' rows. Both APIs receive every case at the same time on one database, so a write
 * that succeeds once (a new link, a deletion, a marking change and its audit row) runs on rows of
 * its own per API: `{w}` is WT for TypeScript and WG for Go, `{del}` and `{ev}` the ids of the
 * links each one deletes or documents. Their texts are equal, so the answers differ only in those
 * ids (normalized) and in the instants each API stamps. Ids are fixed (OVERRIDING SYSTEM VALUE)
 * far above the generated ones. PARITY-ONT-MS is shared: setting the same marking from both APIs
 * at once is idempotent, so one row is changed and audited, and both answer alike.
 */
const WRITE_IDS = { WT: { del: 39101, ev: 39111 }, WG: { del: 39102, ev: 39112 } } as const;
const OTHER_LINK = 39121;

const writeRecords = (side: 'WT' | 'WG') => [
  record(SECHURA, 'Actores', `PARITY-ONT-${side}-A1`, {
    'Nombre_Actor/Organizacion': 'Gremio escriparidad uno',
    Territorio: 'Costa',
  }),
  record(SECHURA, 'Actores', `PARITY-ONT-${side}-A2`, {
    'Nombre_Actor/Organizacion': 'Gremio escriparidad dos',
  }),
  record(SECHURA, 'Actores', `PARITY-ONT-${side}-A3`, {
    'Nombre_Actor/Organizacion': 'Gremio escriparidad tres',
  }),
  record(SECHURA, 'Actores', `PARITY-ONT-${side}-A4`, {
    'Nombre_Actor/Organizacion': 'Gremio escriparidad cuatro',
  }),
  record(SECHURA, 'Actores', `PARITY-ONT-${side}-A5`, {
    'Nombre_Actor/Organizacion': 'Gremio escriparidad cinco',
  }),
  record(SECHURA, 'Actores', `PARITY-ONT-${side}-A6`, {
    'Nombre_Actor/Organizacion': 'Gremio escriparidad seis',
  }),
  record(SECHURA, 'Actores', `PARITY-ONT-${side}-M1`, {
    'Nombre_Actor/Organizacion': 'Gremio escriparidad marcado',
  }),
  record(SECHURA, 'Fuentes', `PARITY-ONT-${side}-F1`, { Archivo_Fuente: 'acta-escriparidad.pdf' }),
];

const writeLink = (
  id: number,
  tenant: string,
  type: string,
  source: string,
  target: string,
  evidence: string | null,
) =>
  `(${id}, ${quote(tenant)}, ${quote(type)}, 'Actores', ${quote(source)}, 'Actores', ${quote(target)}, 'Sembrado',
    'parity', '2025-03-07T08:09:10.789Z', ${evidence ? quote(evidence) : 'NULL'})`;

const writeSeed = `
INSERT INTO module_records (tenant_id, module, id, payload, marking, created_at, updated_at) VALUES
  ${[
    ...writeRecords('WT'),
    ...writeRecords('WG'),
    record(SECHURA, 'Actores', 'PARITY-ONT-MS', {
      'Nombre_Actor/Organizacion': 'Gremio escriparidad compartido',
    }),
    record(OTHER, 'Actores', 'PARITY-ONT-WX', {
      'Nombre_Actor/Organizacion': 'Gremio escriparidad AJENA',
    }),
  ].join(',\n  ')}
ON CONFLICT DO NOTHING;
INSERT INTO record_links (id, tenant_id, link_type, source_module, source_id, target_module, target_id,
  note, created_by, created_at, evidence_source_id) OVERRIDING SYSTEM VALUE VALUES
  ${(['WT', 'WG'] as const)
    .flatMap((side) => [
      writeLink(
        WRITE_IDS[side].del,
        SECHURA,
        'en_conflicto_con',
        `PARITY-ONT-${side}-A5`,
        `PARITY-ONT-${side}-A6`,
        null,
      ),
      writeLink(
        WRITE_IDS[side].ev,
        SECHURA,
        'aliado_de',
        `PARITY-ONT-${side}-A3`,
        `PARITY-ONT-${side}-A4`,
        null,
      ),
    ])
    .concat(
      writeLink(
        OTHER_LINK,
        OTHER,
        'en_conflicto_con',
        'PARITY-ONT-A1',
        'PARITY-ONT-A2',
        'PARITY-ONT-F1',
      ),
    )
    .join(',\n  ')}
ON CONFLICT DO NOTHING;
`;

export const seed = `
INSERT INTO module_records (tenant_id, module, id, payload, marking, created_at, updated_at) VALUES
  ${[...records(SECHURA, ''), ...records(OTHER, ' AJENA')].join(',\n  ')}
ON CONFLICT DO NOTHING;
INSERT INTO record_links (tenant_id, link_type, source_module, source_id, target_module, target_id,
  note, created_by, created_at, evidence_source_id) VALUES
  ${[...links(SECHURA, ''), ...links(OTHER, ' AJENA')].join(',\n  ')}
ON CONFLICT DO NOTHING;
${writeSeed}`;

const SECOND = { 'x-sipges-scope': 'PARITY/PRJ-B' };
const FIRST = { 'x-sipges-scope': SECHURA };

/** The scope and session cases every route gets. */
const gates = (route: string, path: string): ParityCase[] => {
  const glue = path.includes('?') ? '&' : '?';
  return [
    { name: `ontology ${route}: without a session`, method: 'GET', path },
    { name: `ontology ${route}: read-only role`, method: 'GET', path, auth: 'consulta' },
    { name: `ontology ${route}: two projects need a choice`, method: 'GET', path, auth: 'multi' },
    {
      name: `ontology ${route}: second project`,
      method: 'GET',
      path,
      auth: 'multi',
      headers: SECOND,
    },
    {
      name: `ontology ${route}: first project of a two-project user`,
      method: 'GET',
      path,
      auth: 'multi',
      headers: FIRST,
    },
    {
      name: `ontology ${route}: project without a grant`,
      method: 'GET',
      path,
      auth: 'admin',
      headers: SECOND,
    },
    {
      name: `ontology ${route}: the ungranted fixture project`,
      method: 'GET',
      path,
      auth: 'multi',
      headers: { 'x-sipges-scope': OTHER },
    },
    {
      name: `ontology ${route}: project_id of another project`,
      method: 'GET',
      path: `${path}${glue}project_id=OTRO`,
      auth: 'admin',
    },
    {
      name: `ontology ${route}: project_id of its project`,
      method: 'GET',
      path: `${path}${glue}project_id=PRJ-SECHURA`,
      auth: 'admin',
    },
    { name: `ontology ${route}: HEAD`, method: 'HEAD', path, auth: 'admin' },
  ];
};

const admin = (name: string, path: string, auth: ParityCase['auth'] = 'admin'): ParityCase => ({
  name: `ontology ${name}`,
  method: 'GET',
  path,
  auth,
});

const LONG_QUERY = encodeURIComponent(`${'o'.repeat(199)}😀 ontoparidad`);

/** Each API's own rows of the writes (see writeSeed). */
const W = {
  w: { ts: 'WT', go: 'WG' },
  del: { ts: String(WRITE_IDS.WT.del), go: String(WRITE_IDS.WG.del) },
  ev: { ts: String(WRITE_IDS.WT.ev), go: String(WRITE_IDS.WG.ev) },
} as const;
const actor = (n: string) => ({ module: 'actores', id: `PARITY-ONT-{w}-${n}` });
const LINKS_OF = (n: string) => `/system/links?module=actores&id=PARITY-ONT-{w}-${n}`;
/** The fields of a links answer that hold an API's own ids or instants. */
const LINKS_NORMALIZED = [
  'record.id',
  'links.*.edge.id',
  'links.*.edge.source.id',
  'links.*.edge.target.id',
  'links.*.edge.created_at',
  'links.*.edge.evidence.id',
  'links.*.other.id',
];

type Write = Omit<ParityCase, 'name' | 'auth' | 'sameOrigin'> & {
  readonly auth?: ParityCase['auth'] | null;
  readonly sameOrigin?: false;
};
/** A write case: the administrator, same origin, with each API's own rows unless it says otherwise. */
const write = (name: string, c: Write): ParityCase => {
  const { auth, sameOrigin, ...rest } = c;
  return {
    name: `ontology write: ${name}`,
    vary: W,
    ...rest,
    ...(auth === null ? {} : { auth: auth ?? 'admin' }),
    ...(sameOrigin === false ? {} : { sameOrigin: true as const }),
  };
};
const readOwn = (name: string, path: string, auth: ParityCase['auth'] = 'admin'): ParityCase =>
  write(name, { method: 'GET', path, auth, normalize: LINKS_NORMALIZED });

const newLink = {
  link_type: 'aliado_de',
  source: actor('A1'),
  target: actor('A2'),
  note: '  Alianza escrita\u3000 ',
  evidence: { module: 'fuentes', id: 'PARITY-ONT-{w}-F1' },
};
const aLink = (extra: Record<string, unknown>) => ({
  link_type: 'aliado_de',
  source: actor('A1'),
  target: actor('A3'),
  ...extra,
});
const marking = (id: string, value: string) => ({ module: 'actores', id, marking: value });
const SEEDS_BODY = {
  seeds: [
    { module: 'eventos', id: 'PARITY-ONT-E1' },
    { module: 'eventos', id: 'PARITY-ONT-E1' },
    { module: 'nada', id: 'PARITY-ONT-E1' },
    { module: 'alertas', id: 'PARITY-ONT-AL1' },
    { module: 'actores', id: 'PARITY-ONT-NOPE' },
  ],
  hops: [['origina', 'sustenta'], ['atiende']],
  fields: ['Tipo_Evento', 'Responsable', 'Tipo_Evento'],
};

const WRITES: ParityCase[] = [
  // POST /system/links: created, then read back; the same link again (also reversed) is a duplicate.
  write('create a link', {
    method: 'POST',
    path: '/system/links',
    body: { json: newLink },
    normalize: ['id'],
  }),
  readOwn('the new link is read back', LINKS_OF('A1')),
  readOwn('the new link from its target', LINKS_OF('A2'), 'consulta'),
  write('create the same link again', {
    method: 'POST',
    path: '/system/links',
    body: { json: newLink },
  }),
  write('create it reversed (symmetric type)', {
    method: 'POST',
    path: '/system/links',
    body: { json: { ...newLink, source: actor('A2'), target: actor('A1') } },
  }),
  ...(
    [
      ['unknown link type', aLink({ link_type: 'amigo_de' })],
      ['unknown object type', aLink({ source: { module: 'Actores', id: 'PARITY-ONT-{w}-A1' } })],
      ['self link', aLink({ target: actor('A1') })],
      ['type not allowed between those objects', aLink({ link_type: 'participa_en' })],
      ['missing end', aLink({ target: actor('NOPE') })],
      [
        'end only in another project',
        aLink({ target: { module: 'actores', id: 'PARITY-ONT-WX' } }),
      ],
      [
        'evidence that does not exist',
        aLink({ evidence: { module: 'fuentes', id: 'PARITY-ONT-NOPE' } }),
      ],
      [
        'evidence of another type',
        aLink({ evidence: { module: 'actores', id: 'PARITY-ONT-{w}-A2' } }),
      ],
      ['empty body', {}],
      [
        'nested errors',
        { link_type: '', source: { module: 'x'.repeat(41), id: 'a\u0000b' }, target: [], note: 5 },
      ],
      ['body not an object', [aLink({})]],
    ] as const
  ).map(([name, json]) =>
    write(`create: ${name}`, { method: 'POST', path: '/system/links', body: { json } }),
  ),
  write('create: invalid JSON', {
    method: 'POST',
    path: '/system/links',
    body: { raw: '{"link_type":' },
  }),
  write('create: byte order mark', {
    method: 'POST',
    path: '/system/links',
    body: {
      raw: `\ufeff${JSON.stringify(aLink({ link_type: 'en_conflicto_con', target: actor('A4') }))}`,
    },
    normalize: ['id'],
  }),
  write('create: by the read-only role', {
    method: 'POST',
    path: '/system/links',
    body: { json: aLink({}) },
    auth: 'consulta',
  }),
  write('create: without a session', {
    method: 'POST',
    path: '/system/links',
    body: { json: aLink({}) },
    auth: null,
  }),
  write('create: without Origin', {
    method: 'POST',
    path: '/system/links',
    body: { json: aLink({}) },
    sameOrigin: false,
  }),
  write('create: two projects need a choice', {
    method: 'POST',
    path: '/system/links',
    body: { json: aLink({}) },
    auth: 'multi',
  }),
  write('create: in the second project the records do not exist', {
    method: 'POST',
    path: '/system/links',
    body: { json: aLink({}) },
    auth: 'multi',
    headers: SECOND,
  }),
  write('create: project without a grant', {
    method: 'POST',
    path: '/system/links',
    body: { json: aLink({}) },
    headers: SECOND,
  }),
  write('create: the ungranted fixture project', {
    method: 'POST',
    path: '/system/links',
    body: { json: aLink({}) },
    auth: 'multi',
    headers: { 'x-sipges-scope': OTHER },
  }),
  write('create: body naming another project', {
    method: 'POST',
    path: '/system/links',
    body: { json: { ...aLink({}), project_id: 'OTRO' } },
  }),
  write('create: trailing slash', {
    method: 'POST',
    path: '/system/links/',
    body: { json: aLink({}) },
  }),
  readOwn('nothing else was created', LINKS_OF('A3')),

  // PUT /system/links/:id/evidence: documented, read back, withdrawn, repeated.
  ...[1, 2].map((n) =>
    write(`document a link (${n})`, {
      method: 'PUT',
      path: '/system/links/{ev}/evidence',
      body: { json: { evidence: { module: 'fuentes', id: 'PARITY-ONT-{w}-F1' } } },
    }),
  ),
  readOwn('the evidence is read back', LINKS_OF('A3')),
  ...[1, 2].map((n) =>
    write(`withdraw the evidence (${n})`, {
      method: 'PUT',
      path: '/system/links/{ev}/evidence',
      body: { json: { evidence: null } },
    }),
  ),
  readOwn('the withdrawn evidence is read back', LINKS_OF('A4')),
  write('evidence: a source that does not exist', {
    method: 'PUT',
    path: '/system/links/{ev}/evidence',
    body: { json: { evidence: { module: 'fuentes', id: 'PARITY-ONT-NOPE' } } },
  }),
  write('evidence: a link of another project', {
    method: 'PUT',
    path: `/system/links/${OTHER_LINK}/evidence`,
    body: { json: { evidence: null } },
  }),
  ...['abc', '-1', '1234567890', '999999999', '%31', '1.0'].map((id) =>
    write(`evidence: link id ${id}`, {
      method: 'PUT',
      path: `/system/links/${id}/evidence`,
      body: { json: { evidence: null } },
    }),
  ),
  ...(
    [
      ['missing evidence', {}],
      ['evidence of another type', { evidence: { module: 'actores', id: 'x' } }],
      ['evidence not an object', { evidence: 5 }],
      ['evidence id empty', { evidence: { module: 'fuentes', id: '' } }],
    ] as const
  ).map(([name, json]) =>
    write(`evidence: ${name}`, {
      method: 'PUT',
      path: '/system/links/abc/evidence',
      body: { json },
    }),
  ),
  write('evidence: by the read-only role', {
    method: 'PUT',
    path: '/system/links/{ev}/evidence',
    body: { json: { evidence: null } },
    auth: 'consulta',
  }),
  write('evidence: without a session', {
    method: 'PUT',
    path: '/system/links/{ev}/evidence',
    body: { json: { evidence: null } },
    auth: null,
  }),

  // PUT /system/marking: a restricted record disappears for consulta, and comes back when lowered.
  write('mark a shared record restricted (both at once)', {
    method: 'PUT',
    path: '/system/marking',
    body: { json: marking('PARITY-ONT-MS', 'restringido') },
  }),
  write('the marking change is the newest audit row', {
    method: 'GET',
    path: '/system/audit?limit=1',
    sameOrigin: false,
  }),
  write('the read-only role no longer sees the shared record', {
    method: 'GET',
    path: '/system/links?module=actores&id=PARITY-ONT-MS',
    auth: 'consulta',
  }),
  write('nor finds it', {
    method: 'GET',
    path: '/system/search?q=PARITY-ONT-MS',
    auth: 'consulta',
  }),
  write('the administrator still does', {
    method: 'GET',
    path: '/system/links?module=actores&id=PARITY-ONT-MS',
  }),
  write('raise its own record', {
    method: 'PUT',
    path: '/system/marking',
    body: { json: marking('PARITY-ONT-{w}-M1', 'restringido') },
  }),
  write('raise it again', {
    method: 'PUT',
    path: '/system/marking',
    body: { json: marking('PARITY-ONT-{w}-M1', 'restringido') },
  }),
  readOwn('the read-only role stops seeing it', LINKS_OF('M1'), 'consulta'),
  write('the read-only role may not lower it', {
    method: 'PUT',
    path: '/system/marking',
    body: { json: marking('PARITY-ONT-{w}-M1', 'publico') },
    auth: 'consulta',
  }),
  write('an analyst lowers it', {
    method: 'PUT',
    path: '/system/marking',
    body: { json: marking('PARITY-ONT-{w}-M1', 'publico') },
    auth: 'multi',
    headers: FIRST,
  }),
  readOwn('the read-only role sees it again', LINKS_OF('M1'), 'consulta'),
  write('marking: without a session', {
    method: 'PUT',
    path: '/system/marking',
    body: { json: marking('PARITY-ONT-MS', 'publico') },
    auth: null,
  }),
  write('marking: a record of another project', {
    method: 'PUT',
    path: '/system/marking',
    body: { json: marking('PARITY-ONT-WX', 'restringido') },
  }),
  write('marking: from the second project', {
    method: 'PUT',
    path: '/system/marking',
    body: { json: marking('PARITY-ONT-{w}-M1', 'restringido') },
    auth: 'multi',
    headers: SECOND,
  }),
  write('marking: the stored module name', {
    method: 'PUT',
    path: '/system/marking',
    body: { json: { module: 'Actores', id: 'PARITY-ONT-{w}-M1', marking: 'interno' } },
  }),
  write('marking: a record that does not exist', {
    method: 'PUT',
    path: '/system/marking',
    body: { json: marking('PARITY-ONT-NOPE', 'interno') },
  }),
  ...(
    [
      ['unknown marking', marking('PARITY-ONT-MS', 'secreto')],
      ['empty body', {}],
      ['id too long', { module: '', id: 'x'.repeat(201), marking: null }],
    ] as const
  ).map(([name, json]) =>
    write(`marking: ${name}`, { method: 'PUT', path: '/system/marking', body: { json } }),
  ),
  write('marking: trailing slash', {
    method: 'PUT',
    path: '/system/marking/',
    body: { json: marking('PARITY-ONT-MS', 'publico') },
  }),
  write('marking: GET is not a route', {
    method: 'GET',
    path: '/system/marking',
    sameOrigin: false,
  }),

  // DELETE /system/links/:id: refused outside its project, deleted, then absent.
  write('delete: by the read-only role', {
    method: 'DELETE',
    path: '/system/links/{del}',
    auth: 'consulta',
  }),
  write('delete: from the second project', {
    method: 'DELETE',
    path: '/system/links/{del}',
    auth: 'multi',
    headers: SECOND,
  }),
  write('delete: without a session', { method: 'DELETE', path: '/system/links/{del}', auth: null }),
  write('delete: without Origin', {
    method: 'DELETE',
    path: '/system/links/{del}',
    sameOrigin: false,
  }),
  readOwn('the link to delete is still there', LINKS_OF('A5')),
  write('delete a link', { method: 'DELETE', path: '/system/links/{del}' }),
  readOwn('the deleted link is gone', LINKS_OF('A5')),
  write('delete it again', { method: 'DELETE', path: '/system/links/{del}' }),
  write('delete: a link of another project', {
    method: 'DELETE',
    path: `/system/links/${OTHER_LINK}`,
  }),
  ...['abc', '-1', '1234567890', '%31%32'].map((id) =>
    write(`delete: link id ${id}`, { method: 'DELETE', path: `/system/links/${id}` }),
  ),
  write('delete: no id', { method: 'DELETE', path: '/system/links/' }),

  // POST /system/graph/neighbourhood: a read every role may send.
  write('neighbourhood', {
    method: 'POST',
    path: '/system/graph/neighbourhood',
    body: { json: SEEDS_BODY },
  }),
  write('neighbourhood, read-only role', {
    method: 'POST',
    path: '/system/graph/neighbourhood',
    body: { json: SEEDS_BODY },
    auth: 'consulta',
  }),
  write('neighbourhood: second project', {
    method: 'POST',
    path: '/system/graph/neighbourhood',
    body: { json: SEEDS_BODY },
    auth: 'multi',
    headers: SECOND,
  }),
  write('neighbourhood: one hop of every type', {
    method: 'POST',
    path: '/system/graph/neighbourhood',
    body: {
      json: {
        seeds: [{ module: 'actores', id: 'PARITY-ONT-A1' }],
        hops: [['aliado_de', 'relacionado_con']],
      },
    },
  }),
  write('neighbourhood: unknown link type', {
    method: 'POST',
    path: '/system/graph/neighbourhood',
    body: { json: { ...SEEDS_BODY, hops: [['origina'], ['amigo_de', 'otro']] } },
  }),
  ...(
    [
      ['no seeds', { seeds: [], hops: [['origina']] }],
      ['three hops', { seeds: SEEDS_BODY.seeds, hops: [['a'], ['b'], ['c']] }],
      [
        'too many seeds',
        {
          seeds: Array.from({ length: 101 }, (_, i) => ({ module: 'actores', id: `S${i}` })),
          hops: [['origina']],
        },
      ],
      [
        'bad fields',
        { seeds: SEEDS_BODY.seeds, hops: [['origina']], fields: ['', 'x'.repeat(61), 5] },
      ],
    ] as const
  ).map(([name, json]) =>
    write(`neighbourhood: ${name}`, {
      method: 'POST',
      path: '/system/graph/neighbourhood',
      body: { json },
    }),
  ),
  write('neighbourhood: without a session', {
    method: 'POST',
    path: '/system/graph/neighbourhood',
    body: { json: SEEDS_BODY },
    auth: null,
  }),
  write('neighbourhood: without Origin', {
    method: 'POST',
    path: '/system/graph/neighbourhood',
    body: { json: SEEDS_BODY },
    sameOrigin: false,
  }),
  write('neighbourhood: two projects need a choice', {
    method: 'POST',
    path: '/system/graph/neighbourhood',
    body: { json: SEEDS_BODY },
    auth: 'multi',
  }),
  write('neighbourhood: the ungranted fixture project', {
    method: 'POST',
    path: '/system/graph/neighbourhood',
    body: { json: SEEDS_BODY },
    auth: 'multi',
    headers: { 'x-sipges-scope': OTHER },
  }),
];

export const cases: readonly ParityCase[] = [
  admin('catalog', '/system/ontology'),
  ...gates('catalog', '/system/ontology'),
  admin('catalog: trailing slash', '/system/ontology/'),

  admin('search', '/system/search?q=ontoparidad'),
  ...gates('search', '/system/search?q=ontoparidad'),
  admin(
    'search: accents and case fold',
    `/system/search?q=${encodeURIComponent('ÑANDÚ Asociación')}`,
  ),
  admin('search: exact id, any case', '/system/search?q=parity-ont-a1'),
  admin(
    'search: exact id read-only hides restricted',
    '/system/search?q=PARITY-ONT-AL1',
    'consulta',
  ),
  admin('search: exact id restricted', '/system/search?q=PARITY-ONT-AL1'),
  admin('search: modules filter', '/system/search?q=ontoparidad&modules=eventos,actores'),
  admin('search: empty modules list', '/system/search?q=ontoparidad&modules=,'),
  admin('search: unknown modules only', '/system/search?q=ontoparidad&modules=nada'),
  admin('search: limit', '/system/search?q=ontoparidad&limit=2'),
  admin('search: limit zero', '/system/search?q=ontoparidad&limit=0'),
  admin('search: negative limit', '/system/search?q=ontoparidad&limit=-5'),
  admin('search: limit with spaces and sign', '/system/search?q=ontoparidad&limit=%20%2B3%20'),
  admin('search: huge limit', '/system/search?q=ontoparidad&limit=99999999999999999999999'),
  admin('search: limit not an integer', '/system/search?q=ontoparidad&limit=2.5'),
  admin('search: limit empty', '/system/search?q=ontoparidad&limit='),
  admin('search: no query', '/system/search'),
  admin('search: only short words', '/system/search?q=a%20b'),
  admin('search: several terms', '/system/search?q=ontoparidad%20agua'),
  admin('search: digit term', '/system/search?q=ontoparidad%201'),
  admin('search: excerpt deep in a long field', '/system/search?q=nota%20larga'),
  admin('search: query cut inside an emoji', `/system/search?q=${LONG_QUERY}`),
  admin('search: plus as space', '/system/search?q=demanda+agua'),
  admin('search: trailing slash', '/system/search/?q=ontoparidad'),

  admin('timeline', '/system/timeline?from=2024-12&to=2025-03'),
  ...gates('timeline', '/system/timeline?from=2024-12&to=2025-03'),
  admin('timeline: one module', '/system/timeline?from=2024&to=2025&modules=fuentes'),
  admin('timeline: undated module only', '/system/timeline?modules=acciones'),
  admin('timeline: truncated', '/system/timeline?from=2024-12-01&to=2025-03-31&limit=1'),
  admin('timeline: limit zero', '/system/timeline?from=2024-12-01&to=2025-03-31&limit=0'),
  admin('timeline: from after to', '/system/timeline?from=2025-04&to=2025-01'),
  admin('timeline: invalid month', '/system/timeline?from=2025-13'),
  admin('timeline: invalid day text', '/system/timeline?to=marzo'),
  admin('timeline: cut to ten characters', '/system/timeline?from=%20%202025-03-01'),
  admin('timeline: spaces around a year', '/system/timeline?from=%202025%20&to=2025'),
  admin('timeline: limit not an integer', '/system/timeline?limit=x&from=bad'),
  admin(
    'timeline: day of a month that does not exist',
    '/system/timeline?from=2025-02-30&to=2025-03-04',
  ),

  admin('links of an actor', '/system/links?module=actores&id=PARITY-ONT-A1'),
  ...gates('links', '/system/links?module=actores&id=PARITY-ONT-A1'),
  admin('links of an event', '/system/links?module=eventos&id=PARITY-ONT-E1'),
  admin(
    'links of an event, read-only role',
    '/system/links?module=eventos&id=PARITY-ONT-E1',
    'consulta',
  ),
  admin('links of a source', '/system/links?module=fuentes&id=PARITY-ONT-F1'),
  admin(
    'links of an action, read-only role',
    '/system/links?module=acciones&id=PARITY-ONT-AC1',
    'consulta',
  ),
  admin(
    'links of a restricted alert, read-only role',
    '/system/links?module=alertas&id=PARITY-ONT-AL1',
    'consulta',
  ),
  admin('links of a restricted alert', '/system/links?module=alertas&id=PARITY-ONT-AL1'),
  admin('links: missing record', '/system/links?module=actores&id=PARITY-ONT-NOPE'),
  admin('links: unknown module', '/system/links?module=nada&id=PARITY-ONT-A1'),
  admin(
    'links: stored module name instead of slug',
    '/system/links?module=Actores&id=PARITY-ONT-A1',
  ),
  admin('links: no parameters', '/system/links'),
  admin('links: id too long', `/system/links?module=actores&id=${'x'.repeat(201)}`),

  admin('graph of an event', '/system/graph?module=eventos&id=PARITY-ONT-E1'),
  ...gates('graph', '/system/graph?module=eventos&id=PARITY-ONT-E1'),
  admin('graph depth 2', '/system/graph?module=eventos&id=PARITY-ONT-E1&depth=2'),
  admin(
    'graph depth 2, read-only role',
    '/system/graph?module=eventos&id=PARITY-ONT-E1&depth=2',
    'consulta',
  ),
  admin('graph depth 0', '/system/graph?module=actores&id=PARITY-ONT-A2&depth=0'),
  admin('graph depth above the bound', '/system/graph?module=actores&id=PARITY-ONT-A2&depth=99'),
  admin('graph depth not an integer', '/system/graph?module=actores&id=PARITY-ONT-A2&depth=uno'),
  admin(
    'graph of a restricted alert, read-only role',
    '/system/graph?module=alertas&id=PARITY-ONT-AL1',
    'consulta',
  ),
  admin('graph: missing record', '/system/graph?module=eventos&id=PARITY-ONT-NOPE'),
  admin('graph: unknown module', '/system/graph?module=nada&id=x'),
  ...WRITES,
];
