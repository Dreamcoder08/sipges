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

/** Sistema screens, reached from the account menu (and Automatizaciones also as Integraciones). */
export const SYSTEM_PATHS = [
  '/administracion',
  '/automatizaciones',
  '/metodologia',
  '/auditoria',
  '/version-4',
] as const satisfies readonly ScreenPath[];

export const labelFor = (path: string): string =>
  SCREENS.find((screen) => screen.path === path)?.label ??
  DESTINATIONS.find((hub) => hub.path === path)?.label ??
  path;

/** A tab of a destination hub: one of today's screens, chosen by `value` in the URL search. */
type HubTab = { value: string; screen: ScreenPath; label: string };
type Tabs = readonly [HubTab, ...HubTab[]];
const tabs = (
  ...entries: readonly [readonly [string, ScreenPath], ...(readonly [string, ScreenPath])[]]
) =>
  entries.map(([value, screen]) => ({ value, screen, label: labelFor(screen) })) as unknown as Tabs;

/**
 * The five destinations (odd/tasks/workspace-architecture.md S3). Each hub renders the screens
 * it absorbs as tabs; the active tab is `?<param>=<value>` and the first tab is the default.
 * The old routes keep working as deep links.
 */
export const DESTINATIONS = [
  {
    path: '/inicio',
    label: 'Inicio',
    icon: 'home',
    param: 'vista',
    tabs: tabs(['dashboard', '/'], ['gerencial', '/gerencia']),
  },
  {
    path: '/registros',
    label: 'Registros',
    icon: 'layers',
    param: 'tipo',
    tabs: tabs(
      ['eventos', '/eventos'],
      ['actores', '/actores'],
      ['directorio', '/directorio'],
      ['demandas', '/demandas'],
      ['narrativas', '/narrativas'],
      ['fuentes', '/fuentes'],
      ['buzon', '/buzon'],
    ),
  },
  {
    path: '/territorio',
    label: 'Territorio',
    icon: 'map',
    param: 'vista',
    tabs: tabs(['mapa', '/mapa'], ['ubicacion', '/ubicacion'], ['cronologia', '/cronologia']),
  },
  {
    path: '/bandeja',
    label: 'Bandeja',
    icon: 'inbox',
    param: 'vista',
    tabs: tabs(
      ['alertas', '/alertas'],
      ['validacion', '/validacion'],
      ['calidad', '/calidad'],
      ['situaciones', '/situaciones'],
    ),
  },
  {
    path: '/analisis',
    label: 'Análisis',
    icon: 'chart',
    param: 'vista',
    // Inteligencia de redes is not named in S3; it joins here so it stays reachable.
    tabs: tabs(
      ['irsa', '/irsa'],
      ['situacional', '/situacion'],
      ['estrategica', '/estrategia'],
      ['lecciones', '/lecciones'],
      ['redes', '/inteligencia-redes'],
    ),
  },
] as const satisfies readonly {
  path: string;
  label: string;
  icon: IconName;
  param: string;
  tabs: Tabs;
}[];

export type DestinationPath = (typeof DESTINATIONS)[number]['path'];
export type NavPath = ScreenPath | DestinationPath;
export type Destination = (typeof DESTINATIONS)[number];

/** The destination that owns a path: its hub or one of the old screens it absorbs. */
export const destinationFor = (path: string): Destination | undefined =>
  DESTINATIONS.find((hub) => hub.path === path || hub.tabs.some((tab) => tab.screen === path));

export const hubHref = (hub: Destination, value: string) =>
  value === hub.tabs[0].value ? hub.path : `${hub.path}?${hub.param}=${value}`;

/** What the «Recientes» list stores for a screen or hub tab; null for routes outside the menu. */
export const visitFor = (path: string, search: string): { href: string; label: string } | null => {
  const hub = DESTINATIONS.find((item) => item.path === path);
  if (!hub) {
    return SCREENS.some((screen) => screen.path === path)
      ? { href: path + search, label: labelFor(path) }
      : null;
  }
  const asked = new URLSearchParams(search).get(hub.param);
  const tab = hub.tabs.find((item) => item.value === asked) ?? hub.tabs[0];
  return { href: hubHref(hub, tab.value), label: `${hub.label} · ${tab.label}` };
};

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

export const iconFor = (path: NavPath): IconName =>
  path in SCREEN_ICONS
    ? SCREEN_ICONS[path as ScreenPath]
    : (DESTINATIONS.find((hub) => hub.path === path)?.icon ?? 'layers');

/**
 * Phone and tablet bottom bar (docs/adr/0015): four destinations; the rest is in the "Más" sheet.
 */
export const MOBILE_TABS = [
  { path: '/inicio', label: 'Inicio' },
  { path: '/registros', label: 'Registros' },
  { path: '/bandeja', label: 'Bandeja' },
  { path: '/territorio', label: 'Territorio' },
] as const satisfies readonly { path: DestinationPath; label: string }[];

/** "Más" sheet: the destination without a tab, then Sistema; hubs reach their old screens. */
export const MORE_GROUPS = [
  { label: 'Destinos', paths: ['/analisis'] },
  { label: 'Sistema', paths: SYSTEM_PATHS },
] as const satisfies readonly { label: string; paths: readonly NavPath[] }[];

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
  SCREENS.find((screen) => screen.path === path)?.title ??
  DESTINATIONS.find((hub) => hub.path === path)?.label ??
  'SIPGES';

/** Only same-app paths are accepted as a post-login destination (no open redirect). */
export const safeRedirect = (value: unknown) =>
  typeof value === 'string' && /^\/(?![/\\])/.test(value) ? value : '/';
