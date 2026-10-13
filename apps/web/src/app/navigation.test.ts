import { describe, expect, it } from 'vitest';
import { SCREENS, safeRedirect, titleFor } from './navigation.ts';

describe('navigation', () => {
  it('keeps post-login redirects inside the app', () => {
    expect(safeRedirect('/irsa?x=1')).toBe('/irsa?x=1');
    for (const value of ['//evil.example', '/\\evil.example', 'https://evil.example', 'irsa', 3]) {
      expect(safeRedirect(value)).toBe('/');
    }
  });

  it('lists every legacy screen once with a title', () => {
    expect(SCREENS).toHaveLength(18);
    expect(new Set(SCREENS.map((s) => s.path)).size).toBe(18);
    expect(titleFor('/gerencia')).toBe('Centro de control gerencial');
    expect(titleFor('/nope')).toBe('MASCLI');
  });
});
