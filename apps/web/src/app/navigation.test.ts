import { describe, expect, it } from 'vitest';
import {
  DESTINATIONS,
  SCREEN_ICONS,
  SCREENS,
  SYSTEM_PATHS,
  destinationFor,
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
    expect(SCREENS).toHaveLength(27);
    expect(new Set(SCREENS.map((s) => s.path)).size).toBe(27);
    expect(titleFor('/gerencia')).toBe('Centro de control gerencial');
    expect(titleFor('/nope')).toBe('SIPGES');
  });

  it('offers five destinations whose tabs absorb 22 screens, the rest being Sistema', () => {
    expect(DESTINATIONS.map((hub) => hub.path)).toEqual([
      '/inicio',
      '/registros',
      '/territorio',
      '/bandeja',
      '/analisis',
    ]);
    expect(DESTINATIONS.map((hub) => hub.tabs.length)).toEqual([3, 7, 3, 5, 5]);
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
    expect(destinationFor('/pendientes')?.label).toBe('Bandeja');
    expect(DESTINATIONS[3]?.tabs[0]).toMatchObject({ value: 'pendientes', label: 'Pendientes' });
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

  it('gives every screen an icon', () => {
    expect(Object.keys(SCREEN_ICONS).sort()).toEqual(SCREENS.map((s) => s.path).sort());
    for (const hub of DESTINATIONS) expect(hub.icon).toBeTruthy();
  });
});
