import type { ParityCase } from '../types.ts';

/**
 * Ontology, read-only (T26): GET /system/ontology, /system/search, /system/timeline,
 * /system/links and /system/graph. The seed adds records and links in the default project and,
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

export const seed = `
INSERT INTO module_records (tenant_id, module, id, payload, marking, created_at, updated_at) VALUES
  ${[...records(SECHURA, ''), ...records(OTHER, ' AJENA')].join(',\n  ')}
ON CONFLICT DO NOTHING;
INSERT INTO record_links (tenant_id, link_type, source_module, source_id, target_module, target_id,
  note, created_by, created_at, evidence_source_id) VALUES
  ${[...links(SECHURA, ''), ...links(OTHER, ' AJENA')].join(',\n  ')}
ON CONFLICT DO NOTHING;
`;

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
];
