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
  { path: '/pendientes', label: 'Pendientes', title: 'Pendientes de decisión', ready: true },
  { path: '/avisos', label: 'Avisos', title: 'Avisos', ready: true },
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
  { path: '/riesgo', label: 'Riesgo de conflicto', title: 'Riesgo de conflicto', ready: true },
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
  { path: '/integraciones', label: 'Integraciones', title: 'Integraciones', ready: true },
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

/** Sistema screens, reached from the account menu; Integraciones has its own sidebar link. */
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
type TabEntry = readonly [value: string, screen: ScreenPath, label?: string];
const tabs = (...entries: readonly [TabEntry, ...TabEntry[]]) =>
  entries.map(([value, screen, label]) => ({
    value,
    screen,
    label: label ?? labelFor(screen),
  })) as unknown as Tabs;

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
    // The first tab is the briefing page (features/dashboard/inicio); it has no screen of its own
    // and shares «/» with the Dashboard tab, which keeps the old route's content.
    tabs: tabs(['inicio', '/', 'Inicio'], ['dashboard', '/'], ['gerencial', '/gerencia']),
  },
  {
    path: '/registros',
    label: 'Registros',
    icon: 'layers',
    param: 'tipo',
    // Opens on «Todos», the cross-type list, which is not one of the type tabs.
    home: 'todos',
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
      ['pendientes', '/pendientes'],
      // Automation notifications (ADR 0014); the shell's bell opens this tab (functional-closure S9).
      ['avisos', '/avisos'],
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
      ['riesgo', '/riesgo'],
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
  /** The view at the bare path when it is not the first tab. */
  home?: string;
  tabs: Tabs;
}[];

export type DestinationPath = (typeof DESTINATIONS)[number]['path'];
export type NavPath = ScreenPath | DestinationPath;
export type Destination = (typeof DESTINATIONS)[number];

/** The destination that owns a path: its hub or one of the old screens it absorbs. */
export const destinationFor = (path: string): Destination | undefined =>
  DESTINATIONS.find((hub) => hub.path === path || hub.tabs.some((tab) => tab.screen === path));

/** The view a hub shows at its bare path: its first tab, or its own `home` (Registros › Todos). */
const homeOf = (hub: Destination): string => ('home' in hub ? hub.home : hub.tabs[0].value);

export const hubHref = (hub: Destination, value: string) =>
  value === homeOf(hub) ? hub.path : `${hub.path}?${hub.param}=${value}`;

/** What the «Recientes» list stores for a screen or hub tab; null for routes outside the menu. */
export const visitFor = (path: string, search: string): { href: string; label: string } | null => {
  // Integraciones has its own sidebar link, so listing it under «Recientes» would repeat it.
  if (path === '/integraciones') return null;
  const hub = DESTINATIONS.find((item) => item.path === path);
  if (!hub) {
    // Configuración's sections (`?seccion=`) are one screen, so they share one entry.
    const kept = path === '/version-4' ? '' : search;
    return SCREENS.some((screen) => screen.path === path)
      ? { href: path + kept, label: labelFor(path) }
      : null;
  }
  const asked = new URLSearchParams(search).get(hub.param);
  const tab = hub.tabs.find((item) => item.value === asked) ?? ('home' in hub ? null : hub.tabs[0]);
  // A hub's own page (Inicio, where sign-in lands; Registros › Todos) already has its sidebar link.
  if (!tab || tab.label === hub.label) return null;
  return {
    href: hubHref(hub, tab.value),
    label: tab.label === hub.label ? hub.label : `${hub.label} · ${tab.label}`,
  };
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
  '/pendientes': 'inbox',
  '/avisos': 'alert',
  '/situaciones': 'link',
  '/buzon': 'mail',
  '/lecciones': 'lightbulb',
  '/mapa': 'map',
  '/ubicacion': 'pin',
  '/cronologia': 'clock',
  '/situacion': 'compass',
  '/estrategia': 'target',
  '/irsa': 'chart',
  '/riesgo': 'trend',
  '/validacion': 'check',
  '/calidad': 'grid',
  '/fuentes': 'file',
  '/administracion': 'sliders',
  '/automatizaciones': 'zap',
  '/integraciones': 'plug',
  '/metodologia': 'bookOpen',
  '/auditoria': 'shield',
  '/version-4': 'layers',
};

export const iconFor = (path: NavPath): IconName =>
  path in SCREEN_ICONS
    ? SCREEN_ICONS[path as ScreenPath]
    : (DESTINATIONS.find((hub) => hub.path === path)?.icon ?? 'layers');

export const titleFor = (path: string) =>
  SCREENS.find((screen) => screen.path === path)?.title ??
  DESTINATIONS.find((hub) => hub.path === path)?.label ??
  'SIPGES';

/** Bandeja › «Avisos», the notification inbox the shell's bell opens (functional-closure S9). */
export const AVISOS_HREF = '/bandeja?vista=avisos';

/** Where a signed-in person lands by default: Inicio (functional-closure S6). */
export const HOME_PATH = '/inicio';

/**
 * Only same-app paths are accepted as a post-login destination (no open redirect). The app root
 * counts as no destination, so opening SIPGES and signing in lands on Inicio.
 */
export const safeRedirect = (value: unknown) =>
  typeof value === 'string' && value !== '/' && /^\/(?![/\\])/.test(value) ? value : HOME_PATH;
