import type { IconName } from '../shared/ui/icons.ts';

/**
 * Screens of the legacy UI (static/index.html) in its menu order, plus the cross-module
 * chronology (docs/adr/0011 §7); `ready` ones are rebuilt.
 */
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
  { path: '/situaciones', label: 'Situaciones', title: 'Situaciones relacionadas', ready: true },
  { path: '/buzon', label: 'Buzón', title: 'Buzón de quejas y sugerencias', ready: true },
  { path: '/lecciones', label: 'Lecciones', title: 'Lecciones territoriales', ready: true },
  { path: '/mapa', label: 'Mapa territorial', title: 'Mapa territorial SIPGES', ready: true },
  {
    path: '/ubicacion',
    label: 'Ubicación geoespacial',
    title: 'Ubicación geoespacial del proyecto',
    ready: true,
  },
  {
    path: '/cronologia',
    label: 'Cronología',
    title: 'Cronología territorial',
    ready: true,
  },
  { path: '/situacion', label: 'Análisis situacional', title: 'Análisis situacional', ready: true },
  {
    path: '/estrategia',
    label: 'Inteligencia estratégica',
    title: 'Inteligencia estratégica territorial',
    ready: true,
  },
  { path: '/irsa', label: 'IRSA-SIPGES', title: 'IRSA-SIPGES', ready: true },
  { path: '/validacion', label: 'Validación', title: 'Validación', ready: true },
  {
    path: '/calidad',
    label: 'Calidad de datos',
    title: 'Calidad y trazabilidad de datos',
    ready: true,
  },
  { path: '/fuentes', label: 'Fuentes', title: 'Fuentes y evidencias', ready: true },
  {
    path: '/administracion',
    label: 'Administración',
    title: 'Administración del sistema',
    ready: true,
  },
  {
    path: '/automatizaciones',
    label: 'Automatizaciones',
    title: 'Automatizaciones e integraciones',
    ready: true,
  },
  { path: '/metodologia', label: 'Metodología', title: 'Metodología SIPGES', ready: true },
  { path: '/auditoria', label: 'Auditoría', title: 'Auditoría', ready: true },
  { path: '/version-4', label: 'Configuración', title: 'Configuración del proyecto', ready: true },
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
  {
    label: 'Gestión y alertas',
    paths: [
      '/gerencia',
      '/inteligencia-redes',
      '/alertas',
      '/situaciones',
      '/buzon',
      '/lecciones',
      '/mapa',
      '/ubicacion',
    ],
  },
  {
    label: 'Análisis',
    paths: [
      '/cronologia',
      '/situacion',
      '/estrategia',
      '/irsa',
      '/validacion',
      '/calidad',
      '/fuentes',
    ],
  },
  {
    label: 'Sistema',
    paths: ['/administracion', '/automatizaciones', '/metodologia', '/auditoria', '/version-4'],
  },
] as const satisfies readonly { label: string; paths: readonly ScreenPath[] }[];

/**
 * Desktop sidebar (docs/adr/0015): the screens people open most sit under «Fijados» and are not
 * repeated in their group.
 */
export const PINNED_PATHS = [
  '/',
  '/eventos',
  '/alertas',
  '/mapa',
  '/validacion',
] as const satisfies readonly ScreenPath[];

const PINNED: ReadonlySet<string> = new Set(PINNED_PATHS);

/** Name of the group whose screens live in the account menu instead of the sidebar list. */
const SYSTEM_GROUP = 'Sistema';

/** Collapsible sidebar sections: NAV_GROUPS without the pinned screens and without Sistema. */
export const SIDEBAR_SECTIONS: readonly { label: string; paths: readonly ScreenPath[] }[] =
  NAV_GROUPS.filter((group) => group.label !== SYSTEM_GROUP).map((group) => ({
    label: group.label,
    paths: group.paths.filter((path) => !PINNED.has(path)),
  }));

/** Sistema screens, reached from the account menu. */
export const SYSTEM_PATHS: readonly ScreenPath[] =
  NAV_GROUPS.find((group) => group.label === SYSTEM_GROUP)?.paths ?? [];

/** Label of the NAV_GROUPS group that owns a path, or null for routes outside the menu. */
export const groupLabelFor = (path: string): string | null =>
  NAV_GROUPS.find((group) => (group.paths as readonly string[]).includes(path))?.label ?? null;

/** Icon shown next to each screen in the sidebar, the bottom bar and the "Más" sheet. */
export const SCREEN_ICONS: Readonly<Record<ScreenPath, IconName>> = {
  '/': 'home',
  '/eventos': 'pulse',
  '/actores': 'users',
  '/directorio': 'book',
  '/demandas': 'clipboard',
  '/narrativas': 'message',
  '/gerencia': 'gauge',
  '/inteligencia-redes': 'network',
  '/alertas': 'bell',
  '/situaciones': 'layers',
  '/buzon': 'message',
  '/lecciones': 'layers',
  '/mapa': 'map',
  '/ubicacion': 'pin',
  '/cronologia': 'clock',
  '/situacion': 'compass',
  '/estrategia': 'target',
  '/irsa': 'chart',
  '/validacion': 'check',
  '/calidad': 'check',
  '/fuentes': 'file',
  '/administracion': 'sliders',
  '/automatizaciones': 'zap',
  '/metodologia': 'bookOpen',
  '/auditoria': 'shield',
  '/version-4': 'layers',
};

/**
 * Phone and tablet bottom bar (docs/adr/0015): the four most frequent tasks; every other
 * screen lives in the "Más" sheet.
 */
export const MOBILE_TABS = [
  { path: '/', label: 'Inicio' },
  { path: '/eventos', label: 'Monitoreo' },
  { path: '/alertas', label: 'Alertas' },
  { path: '/mapa', label: 'Territorio' },
] as const satisfies readonly { path: ScreenPath; label: string }[];

/** "Más" sheet, grouped by what the person wants to do rather than by system module. */
export const MORE_GROUPS = [
  {
    label: 'Investigar',
    paths: ['/actores', '/directorio', '/demandas', '/narrativas', '/inteligencia-redes'],
  },
  {
    label: 'Gestionar',
    paths: ['/gerencia', '/situaciones', '/buzon', '/lecciones', '/cronologia', '/ubicacion'],
  },
  {
    label: 'Analizar',
    paths: ['/situacion', '/estrategia', '/irsa', '/validacion', '/calidad', '/fuentes'],
  },
  {
    label: 'Sistema',
    paths: ['/administracion', '/automatizaciones', '/metodologia', '/auditoria', '/version-4'],
  },
] as const satisfies readonly { label: string; paths: readonly ScreenPath[] }[];

export const labelFor = (path: string) =>
  SCREENS.find((screen) => screen.path === path)?.label ?? path;

/**
 * Splits a project label such as "Proyecto Sechura (Migración)" into a short name and a detail
 * line for the phone header; labels without parentheses keep a generic detail.
 */
export const projectParts = (label: string): { name: string; detail: string } => {
  const match = /^(?:Proyecto\s+)?(.+?)\s*\(([^)]+)\)\s*$/i.exec(label.trim());
  if (match?.[1] && match[2]) return { name: match[1], detail: match[2] };
  return { name: label.trim().replace(/^Proyecto\s+/i, '') || label, detail: 'Proyecto activo' };
};

export const titleFor = (path: string) =>
  SCREENS.find((screen) => screen.path === path)?.title ?? 'SIPGES';

/** Only same-app paths are accepted as a post-login destination (no open redirect). */
export const safeRedirect = (value: unknown) =>
  typeof value === 'string' && /^\/(?![/\\])/.test(value) ? value : '/';
