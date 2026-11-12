import { describe, expect, it } from 'vitest';
import {
  DESTINATIONS,
  SCREEN_ICONS,
  SCREENS,
  SYSTEM_PATHS,
  destinationFor,
  filterCommandsFor,
  hubHref,
  safeRedirect,
  titleFor,
  visitFor,
} from './navigation.ts';

describe('navigation', () => {
  it('keeps post-login redirects inside the app', () => {
    expect(safeRedirect('/irsa?x=1')).toBe('/irsa?x=1');
    for (const value of ['//evil.example', '/\\evil.example', 'https://evil.example', 'irsa', 3]) {
      expect(safeRedirect(value)).toBe('/inicio');
    }
    expect(safeRedirect(undefined)).toBe('/inicio');
  });

  it('lists every screen once with a title', () => {
    expect(SCREENS).toHaveLength(30);
    expect(new Set(SCREENS.map((s) => s.path)).size).toBe(30);
    expect(titleFor('/integraciones')).toBe('Integraciones');
    expect(titleFor('/gerencia')).toBe('Centro de control gerencial');
    expect(titleFor('/nope')).toBe('SIPGES');
  });

  it('offers five destinations whose tabs absorb 24 screens, the rest being Sistema', () => {
    expect(DESTINATIONS.map((hub) => hub.path)).toEqual([
      '/inicio',
      '/registros',
      '/territorio',
      '/bandeja',
      '/analisis',
    ]);
    expect(DESTINATIONS.map((hub) => hub.tabs.length)).toEqual([3, 7, 3, 6, 6]);
    expect(SYSTEM_PATHS).toEqual([
      '/administracion',
      '/automatizaciones',
      '/metodologia',
      '/auditoria',
      '/version-4',
    ]);
    const reachable = [
      ...DESTINATIONS.flatMap((hub) => hub.tabs.map((t) => t.screen)),
      ...SYSTEM_PATHS,
      '/integraciones',
    ];
    // The Inicio tab shares «/» with the Dashboard tab.
    expect(new Set(reachable).size).toBe(SCREENS.length);
    expect(new Set(reachable)).toEqual(new Set(SCREENS.map((s) => s.path)));
  });

  it('finds the destination that owns a path, a hub or an absorbed screen', () => {
    expect(destinationFor('/registros')?.label).toBe('Registros');
    expect(destinationFor('/eventos')?.label).toBe('Registros');
    expect(destinationFor('/')?.label).toBe('Inicio');
    expect(destinationFor('/alertas')?.label).toBe('Bandeja');
    expect(destinationFor('/pendientes')?.label).toBe('Bandeja');
    expect(DESTINATIONS[3]?.tabs[0]).toMatchObject({ value: 'pendientes', label: 'Pendientes' });
    // Notifications are «Avisos», a tab of Bandeja (functional-closure S9).
    expect(destinationFor('/avisos')?.label).toBe('Bandeja');
    expect(DESTINATIONS[3]?.tabs[1]).toMatchObject({ value: 'avisos', label: 'Avisos' });
    expect(destinationFor('/lecciones')?.label).toBe('Análisis');
    expect(destinationFor('/riesgo')?.label).toBe('Análisis');
    expect(destinationFor('/auditoria')).toBeUndefined();
    expect(destinationFor('/objeto/eventos/EV-1')).toBeUndefined();
  });

  it('folds only the view a hub opens on into its bare path', () => {
    const [inicio, registros] = DESTINATIONS;
    expect(hubHref(inicio, 'inicio')).toBe('/inicio');
    expect(hubHref(inicio, 'gerencial')).toBe('/inicio?vista=gerencial');
    // Registros opens on «Todos»: its first type, Eventos, needs its own address.
    expect(hubHref(registros, 'todos')).toBe('/registros');
    expect(hubHref(registros, 'eventos')).toBe('/registros?tipo=eventos');
    expect(hubHref(registros, 'actores')).toBe('/registros?tipo=actores');
  });

  it('names a visit by its screen or by its hub tab', () => {
    expect(visitFor('/irsa', '')).toEqual({ href: '/irsa', label: 'IRSA-SIPGES' });
    expect(visitFor('/registros', '?tipo=actores')).toEqual({
      href: '/registros?tipo=actores',
      label: 'Registros · Actores',
    });
    // Registros opens on «Todos», its own page with its sidebar link; Eventos keeps `?tipo=`.
    expect(visitFor('/registros', '')).toBeNull();
    expect(visitFor('/registros', '?tipo=eventos')).toEqual({
      href: '/registros?tipo=eventos',
      label: 'Registros · Eventos',
    });
    // Inicio is where sign-in lands and it already has its own link: no «Recientes» copy.
    expect(visitFor('/inicio', '')).toBeNull();
    expect(visitFor('/inicio', '?vista=inicio')).toBeNull();
    // Configuración is one screen in «Recientes», whichever section was open.
    for (const search of ['', '?seccion=proyecto', '?seccion=privacidad'])
      expect(visitFor('/version-4', search)).toEqual({
        href: '/version-4',
        label: 'Configuración',
      });
    expect(visitFor('/inicio', '?vista=gerencial')).toEqual({
      href: '/inicio?vista=gerencial',
      label: 'Inicio · Centro gerencial',
    });
    expect(visitFor('/objeto/eventos/EV-1', '')).toBeNull();
    expect(visitFor('/integraciones', '')).toBeNull();
  });

  it('offers «Filtrar» commands only where a screen reads the filter from the URL', () => {
    const bandeja = [
      { label: 'Filtrar Bandeja: todo', href: '/bandeja' },
      { label: 'Filtrar Bandeja: alertas', href: '/bandeja?clase=alerta' },
      { label: 'Filtrar Bandeja: calidad de datos', href: '/bandeja?clase=calidad' },
      { label: 'Filtrar Bandeja: situaciones', href: '/bandeja?clase=situacion' },
    ];
    expect(filterCommandsFor('/bandeja', '')).toEqual(bandeja);
    expect(filterCommandsFor('/bandeja', '?vista=pendientes&clase=calidad')).toEqual(bandeja);
    const registros = ['A', 'B', 'C', 'D', 'E'].map((letter) => ({
      label: `Filtrar Registros: verificación ${letter}`,
      href: `/registros?verificacion=${letter}`,
    }));
    expect(filterCommandsFor('/registros', '')).toEqual(registros);
    expect(filterCommandsFor('/registros', '?tipo=todos&ficha=eventos.E-1')).toEqual(registros);
    // Tabs and screens that do not read these filters get none, so no command is a dead link.
    for (const [path, search] of [
      ['/bandeja', '?vista=avisos'],
      ['/registros', '?tipo=eventos'],
      ['/pendientes', ''],
      ['/inicio', ''],
      ['/territorio', ''],
    ] as const)
      expect(filterCommandsFor(path, search)).toEqual([]);
  });

  it('gives every screen an icon', () => {
    expect(Object.keys(SCREEN_ICONS).sort()).toEqual(SCREENS.map((s) => s.path).sort());
    for (const hub of DESTINATIONS) expect(hub.icon).toBeTruthy();
  });

  it('gives each screen its own icon', () => {
    const icons = Object.values(SCREEN_ICONS);
    expect(new Set(icons).size).toBe(icons.length);
  });
});
