import { describe, expect, it } from 'vitest';
import {
  DESTINATIONS,
  MOBILE_TABS,
  MORE_GROUPS,
  SCREEN_ICONS,
  SCREENS,
  SYSTEM_PATHS,
  destinationFor,
  projectParts,
  safeRedirect,
  titleFor,
  visitFor,
} from './navigation.ts';

describe('navigation', () => {
  it('keeps post-login redirects inside the app', () => {
    expect(safeRedirect('/irsa?x=1')).toBe('/irsa?x=1');
    for (const value of ['//evil.example', '/\\evil.example', 'https://evil.example', 'irsa', 3]) {
      expect(safeRedirect(value)).toBe('/');
    }
  });

  it('lists every screen once with a title', () => {
    expect(SCREENS).toHaveLength(26);
    expect(new Set(SCREENS.map((s) => s.path)).size).toBe(26);
    expect(titleFor('/gerencia')).toBe('Centro de control gerencial');
    expect(titleFor('/nope')).toBe('SIPGES');
  });

  it('offers five destinations whose tabs absorb 21 screens, the rest being Sistema', () => {
    expect(DESTINATIONS.map((hub) => hub.path)).toEqual([
      '/inicio',
      '/registros',
      '/territorio',
      '/bandeja',
      '/analisis',
    ]);
    expect(DESTINATIONS.map((hub) => hub.tabs.length)).toEqual([3, 7, 3, 4, 5]);
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
    expect(destinationFor('/lecciones')?.label).toBe('Análisis');
    expect(destinationFor('/auditoria')).toBeUndefined();
    expect(destinationFor('/objeto/eventos/EV-1')).toBeUndefined();
  });

  it('names a visit by its screen or by its hub tab', () => {
    expect(visitFor('/irsa', '')).toEqual({ href: '/irsa', label: 'IRSA-SIPGES' });
    expect(visitFor('/registros', '?tipo=actores')).toEqual({
      href: '/registros?tipo=actores',
      label: 'Registros · Actores',
    });
    expect(visitFor('/registros', '')).toEqual({
      href: '/registros',
      label: 'Registros · Eventos',
    });
    expect(visitFor('/inicio', '')).toEqual({ href: '/inicio', label: 'Inicio' });
    expect(visitFor('/inicio', '?vista=gerencial')).toEqual({
      href: '/inicio?vista=gerencial',
      label: 'Inicio · Centro gerencial',
    });
    expect(visitFor('/objeto/eventos/EV-1', '')).toBeNull();
  });

  it('reaches every screen from the bottom bar, the "Más" sheet or a hub tab', () => {
    const direct = [
      ...MOBILE_TABS.map((tab) => tab.path),
      ...MORE_GROUPS.flatMap((group) => group.paths),
    ];
    expect(new Set(direct).size).toBe(direct.length);
    const hubs = DESTINATIONS.map((hub) => hub.path);
    const reachable = new Set<string>(direct.filter((path) => !hubs.includes(path as never)));
    for (const hub of DESTINATIONS) {
      if (direct.includes(hub.path)) for (const tab of hub.tabs) reachable.add(tab.screen);
    }
    expect(reachable).toEqual(new Set(SCREENS.map((s) => s.path)));
    expect(MOBILE_TABS.map((tab) => tab.label)).toEqual([
      'Inicio',
      'Registros',
      'Bandeja',
      'Territorio',
    ]);
  });

  it('gives every screen an icon', () => {
    expect(Object.keys(SCREEN_ICONS).sort()).toEqual(SCREENS.map((s) => s.path).sort());
    for (const hub of DESTINATIONS) expect(hub.icon).toBeTruthy();
  });

  it('splits project labels into a short name and a detail line', () => {
    expect(projectParts('Proyecto Sechura (Migración)')).toEqual({
      name: 'Sechura',
      detail: 'Migración',
    });
    expect(projectParts('PRJ-SECHURA')).toEqual({ name: 'PRJ-SECHURA', detail: 'Proyecto activo' });
    expect(projectParts('Proyecto Norte')).toEqual({ name: 'Norte', detail: 'Proyecto activo' });
  });
});
