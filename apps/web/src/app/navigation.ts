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
  { path: '/gerencia', label: 'Centro gerencial', title: 'Centro de control gerencial' },
  {
    path: '/inteligencia-redes',
    label: 'Inteligencia de redes',
    title: 'Inteligencia de redes sociales',
  },
  { path: '/alertas', label: 'Alertas', title: 'Centro de alertas' },
  { path: '/mapa', label: 'Mapa territorial', title: 'Mapa territorial MASCLI' },
  { path: '/situacion', label: 'Análisis situacional', title: 'Análisis situacional' },
  {
    path: '/estrategia',
    label: 'Inteligencia estratégica',
    title: 'Inteligencia estratégica territorial',
  },
  { path: '/irsa', label: 'IRSA-MASCLI', title: 'IRSA-MASCLI' },
  { path: '/validacion', label: 'Validación', title: 'Validación' },
  { path: '/fuentes', label: 'Fuentes', title: 'Fuentes y evidencias', ready: true },
  { path: '/administracion', label: 'Administración', title: 'Administración del sistema' },
  { path: '/metodologia', label: 'Metodología', title: 'Metodología MASCLI' },
  { path: '/auditoria', label: 'Auditoría', title: 'Auditoría' },
] as const satisfies readonly {
  path: string;
  label: string;
  title: string;
  ready?: boolean;
}[];

export type ScreenPath = (typeof SCREENS)[number]['path'];

export const titleFor = (path: string) =>
  SCREENS.find((screen) => screen.path === path)?.title ?? 'MASCLI';

/** Only same-app paths are accepted as a post-login destination (no open redirect). */
export const safeRedirect = (value: unknown) =>
  typeof value === 'string' && /^\/(?![/\\])/.test(value) ? value : '/';
