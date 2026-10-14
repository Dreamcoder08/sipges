/** Screens of the legacy UI (static/index.html) in its menu order; `ready` ones are rebuilt. */
export const SCREENS = [
  { path: '/', label: 'Dashboard', title: 'Dashboard ejecutivo', ready: true },
  { path: '/eventos', label: 'Eventos', title: 'Eventos', ready: true },
  { path: '/actores', label: 'Actores', title: 'Mapa y gestión de actores', ready: true },
  {
    path: '/directorio',
    label: 'Directorio territorial',
    title: 'Directorio territorial',
    ready: true,
  },
  { path: '/demandas', label: 'Demandas', title: 'Demandas y compromisos', ready: true },
  {
    path: '/narrativas',
    label: 'Narrativas',
    title: 'Narrativas y señales digitales',
    ready: true,
  },
  {
    path: '/gerencia',
    label: 'Centro gerencial',
    title: 'Centro de control gerencial',
    ready: true,
  },
  {
    path: '/inteligencia-redes',
    label: 'Inteligencia de redes',
    title: 'Inteligencia de redes sociales',
    ready: true,
  },
  { path: '/alertas', label: 'Alertas', title: 'Centro de alertas', ready: true },
  { path: '/mapa', label: 'Mapa territorial', title: 'Mapa territorial MASCLI', ready: true },
  { path: '/situacion', label: 'Análisis situacional', title: 'Análisis situacional', ready: true },
  {
    path: '/estrategia',
    label: 'Inteligencia estratégica',
    title: 'Inteligencia estratégica territorial',
    ready: true,
  },
  { path: '/irsa', label: 'IRSA-MASCLI', title: 'IRSA-MASCLI', ready: true },
  { path: '/validacion', label: 'Validación', title: 'Validación', ready: true },
  { path: '/fuentes', label: 'Fuentes', title: 'Fuentes y evidencias', ready: true },
  {
    path: '/administracion',
    label: 'Administración',
    title: 'Administración del sistema',
    ready: true,
  },
  { path: '/metodologia', label: 'Metodología', title: 'Metodología MASCLI', ready: true },
  { path: '/auditoria', label: 'Auditoría', title: 'Auditoría', ready: true },
] as const satisfies readonly {
  path: string;
  label: string;
  title: string;
  ready?: boolean;
}[];

export type ScreenPath = (typeof SCREENS)[number]['path'];

/**
 * Sidebar sections: contiguous runs of SCREENS, so the legacy menu order is unchanged and the
 * long list is easier to scan (above all in the mobile drawer).
 */
export const NAV_GROUPS = [
  {
    label: 'Monitoreo',
    paths: ['/', '/eventos', '/actores', '/directorio', '/demandas', '/narrativas'],
  },
  { label: 'Gestión y alertas', paths: ['/gerencia', '/inteligencia-redes', '/alertas', '/mapa'] },
  { label: 'Análisis', paths: ['/situacion', '/estrategia', '/irsa', '/validacion', '/fuentes'] },
  { label: 'Sistema', paths: ['/administracion', '/metodologia', '/auditoria'] },
] as const satisfies readonly { label: string; paths: readonly ScreenPath[] }[];

export const titleFor = (path: string) =>
  SCREENS.find((screen) => screen.path === path)?.title ?? 'MASCLI';

/** Only same-app paths are accepted as a post-login destination (no open redirect). */
export const safeRedirect = (value: unknown) =>
  typeof value === 'string' && /^\/(?![/\\])/.test(value) ? value : '/';
