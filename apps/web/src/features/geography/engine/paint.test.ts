/// <reference types="node" />
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PAINT_TOKENS, type PaintToken, paintColour, paintRgb } from './paint.ts';

// Vitest runs from the package directory.
const tokens = readFileSync(join(process.cwd(), 'src/app/styles/tokens.css'), 'utf8');
const names = Object.keys(PAINT_TOKENS) as PaintToken[];

/** The token as defined in each block: :root (light), device dark and picked dark. */
const definitions = (name: string) =>
  [...tokens.matchAll(new RegExp(`${name}:\\s*(#[0-9a-f]{6});`, 'g'))].map((m) => m[1]);

describe('map paint tokens', () => {
  afterEach(() => {
    document.documentElement.style.removeProperty('--map-bg');
    vi.restoreAllMocks();
  });

  it.each(names)('keeps the %s fallback equal to tokens.css in light and dark', (name) => {
    const [light, deviceDark, pickedDark] = definitions(name);
    expect([light, deviceDark, pickedDark]).toEqual([
      PAINT_TOKENS[name][0],
      PAINT_TOKENS[name][1],
      PAINT_TOKENS[name][1],
    ]);
  });

  it('falls back to the theme value when no stylesheet defines the token', () => {
    expect(paintColour('--map-bg', 'light')).toBe('#e9eef3');
    expect(paintColour('--map-bg', 'dark')).toBe('#0b0d10');
  });

  it('reads the token from the document root when it is defined', () => {
    document.documentElement.style.setProperty('--map-bg', ' #123456 ');
    expect(paintColour('--map-bg', 'light')).toBe('#123456');
    expect(paintRgb('--map-bg', 'dark')).toEqual([0x12, 0x34, 0x56]);
  });

  it.each(['red', '#12345', 'var(--other)', '#12345g'])(
    'uses the theme value and warns when the root holds %s instead of six-digit hex',
    (value) => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      document.documentElement.style.setProperty('--map-bg', value);
      expect(paintColour('--map-bg', 'light')).toBe('#e9eef3');
      expect(paintRgb('--map-bg', 'dark')).toEqual([0x0b, 0x0d, 0x10]);
      expect(warn).toHaveBeenCalledWith(
        `Map paint token --map-bg is not six-digit hex: "${value}"; using the theme fallback.`,
      );
    },
  );

  it('does not warn when the token is valid or undefined', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    paintColour('--map-bg', 'light');
    document.documentElement.style.setProperty('--map-bg', '#ABCDEF');
    expect(paintColour('--map-bg', 'light')).toBe('#ABCDEF');
    expect(warn).not.toHaveBeenCalled();
  });

  it('splits a hex token into channels', () => {
    expect(paintRgb('--map-district-line', 'light')).toEqual([23, 54, 93]);
    expect(paintRgb('--map-district-line', 'dark')).toEqual([201, 212, 223]);
  });
});
