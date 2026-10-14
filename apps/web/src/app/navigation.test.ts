import { describe, expect, it } from 'vitest';
import {
  MOBILE_TABS,
  MORE_GROUPS,
  NAV_GROUPS,
  SCREEN_ICONS,
  SCREENS,
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
    expect(SCREENS).toHaveLength(21);
    expect(new Set(SCREENS.map((s) => s.path)).size).toBe(21);
    expect(titleFor('/gerencia')).toBe('Centro de control gerencial');
    expect(titleFor('/nope')).toBe('MASCLI');
  });

  it('groups every screen once, in menu order', () => {
    expect(NAV_GROUPS.flatMap((group) => group.paths)).toEqual(SCREENS.map((s) => s.path));
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
