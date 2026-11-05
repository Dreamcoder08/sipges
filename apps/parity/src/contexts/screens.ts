import type { ParityCase } from '../types.ts';

/**
 * The Inicio and Registros screens as the browser asks for them (T48,
 * docs/deployment/go-activation-reads.md): the exact URLs of `fetchModuleRecords` and of each
 * first paint, always with `X-SIPGES-Scope`, for the sixteen modules the web knows. The routes
 * proposed for the Worker's list must each have a case here or in their context's file; a
 * pattern route would hide a module nobody compared, so every module gets its own rows.
 */
const SECHURA = 'SIPGES/PRJ-SECHURA';
const SECOND = 'PARITY/PRJ-B';
const OTHER = 'PARITY/OTRO';
const SCOPE = 'X-SIPGES-Scope';

/** URL slug of apps/web/src/features/records/modules.ts → stored module name. */
const MODULES = {
  eventos: 'Eventos',
  actores: 'Actores',
  directorio: 'Directorio_Territorial',
  demandas: 'Demandas',
  compromisos: 'Compromisos',
  narrativas: 'Narrativas',
  fuentes: 'Fuentes',
  alertas: 'Alertas',
  acciones: 'Acciones',
  intereses: 'Intereses',
  dialogos: 'Dialogos',
  oportunidades: 'Oportunidades',
  hechos: 'Hechos_Compartidos',
  aarc: 'Evaluaciones_AARC',
  buzon: 'Buzon',
  lecciones: 'Lecciones_Territoriales',
} as const;

const SLUGS = Object.keys(MODULES) as (keyof typeof MODULES)[];

/** One more than a browser page, so a list needs its second request as it would in use. */
const PAGE = 500;

const id = (slug: string, kind: string) => `PARITY-SCR-${slug.toUpperCase()}-${kind}`;

const row = (tenant: string, module: string, key: string, title: string, marking = 'interno') =>
  `('${tenant}', '${module}', '${key}', '{"Nombre": "${title}", "Territorio": "Caleta sintética"}', '${marking}', '2026-03-01T00:00:00Z', '2026-03-01T00:00:00Z')`;

const rows = Object.entries(MODULES).flatMap(([slug, module]) => [
  row(SECHURA, module, id(slug, 'A'), `Fila sintética de ${slug}`),
  row(SECHURA, module, id(slug, 'R'), 'Fila reservada', 'restringido'),
  // The same id in a project nobody holds: a read that crossed projects shows "AJENA".
  row(OTHER, module, id(slug, 'A'), 'Fila AJENA'),
]);

export const seed = `
INSERT INTO module_records (tenant_id, module, id, payload, marking, created_at, updated_at) VALUES
${rows.join(',\n')};
UPDATE module_records SET payload = payload || '{"Estado": "Revisado"}', updated_at = '2026-03-02T00:00:00Z'
  WHERE tenant_id = '${SECHURA}' AND id LIKE 'PARITY-SCR-%-A';
INSERT INTO module_records (tenant_id, module, id, payload, marking, created_at, updated_at)
  SELECT '${SECHURA}', 'Eventos', 'PARITY-SCR-PAGE-' || n, jsonb_build_object('Nombre', 'Evento ' || n),
    'interno', '2026-02-01T00:00:00Z', '2026-02-01T00:00:00Z'
  FROM generate_series(1, ${PAGE + 5}) AS n;
`;

const inProject = { [SCOPE]: SECHURA };

const get = (
  name: string,
  path: string,
  auth: ParityCase['auth'],
  headers: Readonly<Record<string, string>> = inProject,
  normalize?: readonly string[],
): ParityCase => ({
  name: `screens: ${name}`,
  method: 'GET',
  path,
  ...(auth ? { auth } : {}),
  headers,
  ...(normalize ? { normalize } : {}),
});

const list = (slug: string, offset = 0, q = '') =>
  `/api/${slug}?${new URLSearchParams({ limit: String(PAGE), offset: String(offset), q })}`;

const listCases = (slug: string): ParityCase[] => [
  get(`${slug} list`, list(slug), 'admin'),
  get(`${slug} list, read-only role`, list(slug), 'consulta'),
  get(`${slug} list, two projects`, list(slug), 'multi'),
  get(`${slug} list, second project`, list(slug), 'multi', { [SCOPE]: SECOND }),
  get(`${slug} list, ungranted project`, list(slug), 'admin', { [SCOPE]: OTHER }),
  get(`${slug} list, no session`, list(slug), undefined),
  get(`${slug} search`, list(slug, 0, 'sintética'), 'admin'),
];

const recordCases = (slug: string): ParityCase[] => {
  const record = `/api/${slug}/${id(slug, 'A')}`;
  const reserved = `/api/${slug}/${id(slug, 'R')}`;
  return [
    get(`${slug} record`, record, 'admin'),
    get(`${slug} record, no session`, record, undefined),
    get(`${slug} record, ungranted project`, record, 'admin', { [SCOPE]: OTHER }),
    get(`${slug} reserved record, admin`, reserved, 'admin'),
    get(`${slug} reserved record, read-only role`, reserved, 'consulta'),
    get(`${slug} history`, `${record}/history`, 'admin'),
    get(`${slug} reserved history, read-only role`, `${reserved}/history`, 'consulta'),
  ];
};

const CLOCK = ['generated_at'];

/** Every other URL of a first paint, which each context's file reaches by another spelling. */
const firstPaint: readonly ParityCase[] = [
  get('notifications', '/system/notifications?limit=30', 'admin'),
  get('notifications, read-only role', '/system/notifications?limit=30', 'consulta'),
  get('settings', '/system/v4/settings', 'admin'),
  get('dashboard', '/api/dashboard', 'admin', inProject, CLOCK),
  get('dashboard, read-only role', '/api/dashboard', 'consulta', inProject, CLOCK),
  get('IRSA', '/system/irsa', 'admin', inProject, CLOCK),
  get('model status', '/system/model-status', 'admin', inProject, CLOCK),
  get('summary', '/api/registros/summary?limit=500&offset=0', 'admin'),
  get('summary second page', '/api/registros/summary?limit=500&offset=500', 'admin'),
  get('summary, read-only role', '/api/registros/summary?limit=500&offset=0', 'consulta'),
  get('source files', '/system/uploads?linked_module=fuentes&limit=500', 'admin'),
  get('events second page', list('eventos', PAGE), 'admin'),
];

export const cases: readonly ParityCase[] = [
  ...firstPaint,
  ...SLUGS.flatMap(listCases),
  ...SLUGS.flatMap(recordCases),
];
