/**
 * Every write route of the API, each with what it must leave behind. A test in apps/api holds this
 * list to the real router, so a new write route fails until someone says what it writes.
 *
 * `rows` is `domain` for any table but the incidental ones of write-proof.ts, a list of tables
 * when one of them is the promise, and `none`, with `why`, for a POST that only computes.
 */
export type WriteRoute = {
  readonly method: 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  readonly path: string;
  readonly rows: 'domain' | 'none' | readonly string[];
  readonly why?: string;
  /** The normal answer when it is not 2xx. */
  readonly normal?: number;
  /** Why no run can complete this route: it stays listed, and a case must still reach it. */
  readonly blocked?: string;
};

/** The slugs of RECORD_MODULES; the same test holds this list to the source. */
export const RECORD_MODULES = [
  { slug: 'eventos', module: 'Eventos' },
  { slug: 'actores', module: 'Actores' },
  { slug: 'demandas', module: 'Demandas' },
  { slug: 'compromisos', module: 'Compromisos' },
  { slug: 'narrativas', module: 'Narrativas' },
  { slug: 'fuentes', module: 'Fuentes' },
  { slug: 'indicadores', module: 'Indicadores' },
  { slug: 'alertas', module: 'Alertas' },
  { slug: 'acciones', module: 'Acciones' },
  { slug: 'directorio', module: 'Directorio_Territorial' },
  { slug: 'priorizados', module: 'Actores_Priorizados' },
  { slug: 'usuarios', module: 'Usuarios' },
  { slug: 'roles', module: 'Roles' },
  { slug: 'proyectos', module: 'Proyectos' },
  { slug: 'intereses', module: 'Intereses' },
  { slug: 'dialogos', module: 'Dialogos' },
  { slug: 'oportunidades', module: 'Oportunidades' },
  { slug: 'hechos', module: 'Hechos_Compartidos' },
  { slug: 'aarc', module: 'Evaluaciones_AARC' },
  { slug: 'buzon', module: 'Buzon' },
  { slug: 'lecciones', module: 'Lecciones_Territoriales' },
] as const;

/** The routers answer 404 for these imports. */
export const NOT_IMPORTABLE: readonly string[] = ['usuarios', 'roles', 'proyectos'];

const recordRoutes = (slug: string): WriteRoute[] => [
  { method: 'POST', path: `/api/${slug}`, rows: ['module_records'] },
  { method: 'PUT', path: `/api/${slug}/:id`, rows: ['module_records'] },
  { method: 'DELETE', path: `/api/${slug}/:id`, rows: ['module_records'] },
  ...(NOT_IMPORTABLE.includes(slug)
    ? []
    : ([{ method: 'POST', path: `/system/import/${slug}`, rows: ['module_records'] }] as const)),
];

export const WRITE_ROUTES: readonly WriteRoute[] = [
  ...RECORD_MODULES.map(({ slug }) => slug).flatMap(recordRoutes),
  {
    method: 'DELETE',
    path: '/mcp',
    rows: 'none',
    normal: 405,
    why: 'The transport keeps no session',
  },
  { method: 'DELETE', path: '/system/auth/grants', rows: 'domain' },
  { method: 'DELETE', path: '/system/automations/channels/:id', rows: 'domain' },
  { method: 'DELETE', path: '/system/automations/rules/:id', rows: 'domain' },
  { method: 'DELETE', path: '/system/integrations/api-keys/:id', rows: 'domain' },
  { method: 'DELETE', path: '/system/links/:id', rows: 'domain' },
  { method: 'DELETE', path: '/system/v4/media/feeds/:id', rows: 'domain' },
  { method: 'PATCH', path: '/system/document-lab/review/:id', rows: 'domain' },
  { method: 'PATCH', path: '/system/intelligence/territorial-alerts/:id', rows: 'domain' },
  { method: 'PATCH', path: '/system/prevention/actions/:id', rows: 'domain' },
  { method: 'POST', path: '/hooks/ingest/:module', rows: ['module_records'] },
  { method: 'POST', path: '/hooks/signals', rows: 'domain' },
  { method: 'POST', path: '/login', rows: ['sessions'] },
  { method: 'POST', path: '/logout', rows: ['sessions'] },
  { method: 'POST', path: '/mcp', rows: 'domain' },
  { method: 'POST', path: '/select-project', rows: 'none', normal: 303, why: 'Sets a cookie' },
  { method: 'POST', path: '/system/analyze', rows: 'none', why: 'Classifies its input' },
  { method: 'POST', path: '/system/auth/accounts', rows: 'domain' },
  { method: 'POST', path: '/system/auth/accounts/:username/deactivate', rows: 'domain' },
  { method: 'POST', path: '/system/auth/accounts/:username/google', rows: 'domain' },
  { method: 'POST', path: '/system/auth/accounts/:username/reset-mfa', rows: 'domain' },
  { method: 'POST', path: '/system/auth/grants', rows: 'domain' },
  { method: 'POST', path: '/system/auth/scopes', rows: 'domain' },
  {
    method: 'POST',
    path: '/system/auth/totp/enable',
    rows: 'none',
    blocked: 'Needs a live code; writes only users, which has no RLS',
  },
  { method: 'POST', path: '/system/auth/totp/setup', rows: 'domain' },
  { method: 'POST', path: '/system/automations/channels', rows: 'domain' },
  {
    method: 'POST',
    path: '/system/automations/channels/:id/test',
    rows: 'none',
    blocked: 'Sends through a real channel',
  },
  { method: 'POST', path: '/system/automations/cron', rows: 'domain' },
  { method: 'POST', path: '/system/automations/rules', rows: 'domain' },
  {
    method: 'POST',
    path: '/system/automations/tick',
    rows: 'none',
    why: 'Writes only when events wait, and a write already wakes a scan. The cron proves the rows',
  },
  { method: 'POST', path: '/system/briefing/proposals', rows: 'domain' },
  {
    method: 'POST',
    path: '/system/document-lab/analyze',
    rows: 'none',
    why: 'Reads an upload and answers',
  },
  {
    method: 'POST',
    path: '/system/document-lab/compare',
    rows: 'none',
    why: 'Reads two uploads and answers',
  },
  { method: 'POST', path: '/system/document-lab/report.docx', rows: 'none', why: 'Renders a file' },
  { method: 'POST', path: '/system/document-lab/review/bulk', rows: 'domain' },
  { method: 'POST', path: '/system/document-lab/review/import', rows: 'domain' },
  {
    method: 'POST',
    path: '/system/geography/query',
    rows: 'none',
    blocked: 'Asks the external INGEMMET service',
  },
  { method: 'POST', path: '/system/graph/neighbourhood', rows: 'none', why: 'A read over POST' },
  { method: 'POST', path: '/system/integrations/api-keys', rows: 'domain' },
  {
    method: 'POST',
    path: '/system/intelligence/analyze-text',
    rows: 'none',
    why: 'Classifies its input',
  },
  {
    method: 'POST',
    path: '/system/intelligence/semantic-analyze',
    rows: 'none',
    why: 'Classifies its input',
  },
  {
    method: 'POST',
    path: '/system/intelligence/sources/defensoria/import',
    rows: 'none',
    blocked: 'Fetches an external post',
  },
  {
    method: 'POST',
    path: '/system/intelligence/sources/defensoria/poll',
    rows: 'none',
    blocked: 'Fetches the live Defensoría site',
  },
  { method: 'POST', path: '/system/intelligence/territorial-alerts', rows: 'domain' },
  { method: 'POST', path: '/system/irsa/config', rows: 'domain' },
  { method: 'POST', path: '/system/irsa/snapshot', rows: 'domain' },
  { method: 'POST', path: '/system/links', rows: 'domain' },
  { method: 'POST', path: '/system/notifications/push', rows: 'domain' },
  {
    method: 'POST',
    path: '/system/notifications/push/test',
    rows: 'none',
    blocked: 'Sends through a real push service',
  },
  { method: 'POST', path: '/system/notifications/push/unsubscribe', rows: 'domain' },
  { method: 'POST', path: '/system/notifications/read', rows: 'domain' },
  { method: 'POST', path: '/system/prevention/actions', rows: 'domain' },
  { method: 'POST', path: '/system/uploads', rows: 'domain' },
  { method: 'POST', path: '/system/v4/media/feeds', rows: 'domain' },
  { method: 'POST', path: '/system/v4/media/poll', rows: 'domain' },
  {
    method: 'POST',
    path: '/system/v4/media/preview',
    rows: 'none',
    blocked: 'Fetches an external feed',
  },
  { method: 'PUT', path: '/system/automations/rules/:id', rows: 'domain' },
  { method: 'PUT', path: '/system/intelligence/sources/defensoria/config', rows: 'domain' },
  { method: 'PUT', path: '/system/links/:id/evidence', rows: 'domain' },
  { method: 'PUT', path: '/system/marking', rows: 'domain' },
  { method: 'PUT', path: '/system/v4/media/feeds/:id', rows: 'domain' },
  { method: 'PUT', path: '/system/v4/settings', rows: 'domain' },
];
