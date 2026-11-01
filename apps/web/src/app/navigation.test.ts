import { describe, expect, it } from 'vitest';
import {
  MOBILE_TABS,
  MORE_GROUPS,
  NAV_GROUPS,
  PINNED_PATHS,
  SCREEN_ICONS,
  SCREENS,
  SIDEBAR_SECTIONS,
  SYSTEM_PATHS,
  groupLabelFor,
  projectParts,
  safeRedirect,
  titleFor,
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

  it('groups every screen once, in menu order', () => {
    expect(NAV_GROUPS.flatMap((group) => group.paths)).toEqual(SCREENS.map((s) => s.path));
  });

  it('pins five screens and lists the rest once, in groups or under Sistema', () => {
    expect(PINNED_PATHS).toEqual(['/', '/eventos', '/alertas', '/mapa', '/validacion']);
    expect(SIDEBAR_SECTIONS.map((group) => [group.label, group.paths.length])).toEqual([
      ['Monitoreo', 4],
      ['Gestión y alertas', 6],
      ['Análisis', 6],
    ]);
    expect(SYSTEM_PATHS).toEqual([
      '/administracion',
      '/automatizaciones',
      '/metodologia',
      '/auditoria',
      '/version-4',
    ]);
    const reachable = [
      ...PINNED_PATHS,
      ...SIDEBAR_SECTIONS.flatMap((g) => g.paths),
      ...SYSTEM_PATHS,
    ];
    expect(reachable).toHaveLength(SCREENS.length);
    expect(new Set(reachable)).toEqual(new Set(SCREENS.map((s) => s.path)));
  });

  it('finds the group that owns a path, pinned or not', () => {
    expect(groupLabelFor('/eventos')).toBe('Monitoreo');
    expect(groupLabelFor('/mapa')).toBe('Gestión y alertas');
    expect(groupLabelFor('/irsa')).toBe('Análisis');
    expect(groupLabelFor('/auditoria')).toBe('Sistema');
    expect(groupLabelFor('/objeto/eventos/EV-1')).toBeNull();
  });

  it('reaches every screen exactly once from the bottom bar or the "Más" sheet', () => {
    const mobile = [
      ...MOBILE_TABS.map((tab) => tab.path),
      ...MORE_GROUPS.flatMap((group) => group.paths),
    ];
    expect(mobile).toHaveLength(SCREENS.length);
    expect(new Set(mobile)).toEqual(new Set(SCREENS.map((s) => s.path)));
    expect(MOBILE_TABS.map((tab) => tab.label)).toEqual([
      'Inicio',
      'Monitoreo',
      'Alertas',
      'Territorio',
    ]);
  });

  it('gives every screen an icon', () => {
    expect(Object.keys(SCREEN_ICONS).sort()).toEqual(SCREENS.map((s) => s.path).sort());
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
