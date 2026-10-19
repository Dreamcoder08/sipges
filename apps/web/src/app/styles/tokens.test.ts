/// <reference types="node" />
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Guards for the design tokens (docs/adr/0018): modules use semantic tokens instead of raw
 * colours, both dark-theme blocks stay identical, and the text pairs every screen relies on
 * keep WCAG AA contrast in light and dark.
 */
// Vitest runs from the package directory (`pnpm --filter @mascli/web test`).
const SRC = join(process.cwd(), 'src/');
const sheets = Object.fromEntries(
  readdirSync(SRC, { recursive: true, encoding: 'utf8' })
    .filter((path) => path.endsWith('.css'))
    .map((path) => [`/${path.replaceAll('\\', '/')}`, readFileSync(`${SRC}${path}`, 'utf8')]),
);
const tokens = sheets['/app/styles/tokens.css'] ?? '';

/** Cartography keeps its own palette: map paint is data, not interface chrome. */
const RAW_COLOUR_ALLOWED = ['/styles/tokens.css', '/geography/'];
const RAW_COLOUR = /#[0-9a-f]{3,8}\b|\brgba?\(|\bhsla?\(|:\s*(white|black)\s*;/i;

const block = (pattern: RegExp) => {
  const match = pattern.exec(tokens);
  if (!match?.[1]) throw new Error(`token block not found: ${pattern}`);
  return match[1];
};

type Rgba = [number, number, number, number];

const parseColour = (value: string): Rgba => {
  const hex = /^#([0-9a-f]{6})$/i.exec(value);
  if (hex?.[1]) {
    const n = Number.parseInt(hex[1], 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255, 1];
  }
  const rgb = /^rgb\((\d+) (\d+) (\d+)(?: \/ ([\d.]+))?\)$/.exec(value);
  if (rgb) return [Number(rgb[1]), Number(rgb[2]), Number(rgb[3]), Number(rgb[4] ?? 1)];
  throw new Error(`unsupported colour ${value}`);
};

const values = (source: string, base: Record<string, string> = {}) => {
  const map: Record<string, string> = { ...base };
  for (const [, name, value] of source.matchAll(/(--[a-z0-9-]+):\s*([^;]+);/g)) {
    if (name && value) map[name] = value.trim();
  }
  return map;
};

const over = (top: Rgba, bottom: Rgba): Rgba => {
  const a = top[3];
  return [
    top[0] * a + bottom[0] * (1 - a),
    top[1] * a + bottom[1] * (1 - a),
    top[2] * a + bottom[2] * (1 - a),
    1,
  ];
};

const luminance = ([r, g, b]: Rgba) => {
  const channel = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
};

const contrast = (
  theme: Record<string, string>,
  fg: string,
  bg: string,
  base = '--color-surface',
) => {
  const colour = (name: string) => parseColour(theme[name] ?? name);
  const ground = over(colour(bg), colour(base));
  const ink = over(colour(fg), ground);
  const [hi, lo] = [luminance(ink), luminance(ground)].sort((a, b) => b - a) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
};

const light = values(block(/^:root \{([\s\S]*?)^\}/m));
const darkMedia = block(/:root:not\(\[data-theme='light'\]\) \{([\s\S]*?)^ {2}\}/m);
const darkPicked = block(/:root\[data-theme='dark'\] \{([\s\S]*?)^\}/m);
const dark = values(darkPicked, light);

/** Text pairs: [foreground, background]. Each must reach 4.5:1. */
const TEXT_PAIRS: [string, string][] = [
  ['--color-text', '--color-surface'],
  ['--color-text', '--color-bg'],
  ['--color-muted', '--color-surface'],
  ['--color-muted', '--color-bg'],
  ['--color-muted', '--color-surface-alt'],
  ['--color-subtle', '--color-surface'],
  ['--color-brand-text', '--color-surface'],
  ['--color-on-brand', '--color-brand'],
  ['--color-accent-text', '--color-accent-tint'],
  ['--color-danger', '--color-surface'],
  ['--color-danger-strong', '--color-danger-soft'],
  ['--tone-positive-fg', '--tone-positive-bg'],
  ['--tone-negative-fg', '--tone-negative-bg'],
  ['--tone-info-fg', '--tone-info-bg'],
  ['--tone-warning-fg', '--tone-warning-bg'],
  ['--tone-neutral-fg', '--tone-neutral-bg'],
  ['--tone-on-solid', '--tone-positive-solid'],
  ['--level-green-text', '--level-green-soft'],
  ['--level-yellow-text', '--level-yellow-soft'],
  ['--level-orange-text', '--level-orange-soft'],
  ['--level-red-text', '--level-red-soft'],
  ['--heat-green-on', '--heat-green'],
  ['--heat-yellow-on', '--heat-yellow'],
  ['--heat-orange-on', '--heat-orange'],
  ['--heat-red-on', '--heat-red'],
  ['--color-on-strong', '--level-red'],
  ['--ink-strong', '--canvas'],
  ['--ink-soft', '--canvas'],
];

/** Interface marks (focus ring, accent, selected tab): 3:1 against the surface. */
const UI_PAIRS: [string, string][] = [
  ['--color-focus', '--color-surface'],
  ['--color-accent', '--color-surface'],
  ['--color-brand', '--color-surface'],
];

describe('design tokens', () => {
  it('keeps raw colours out of modules', () => {
    const offenders = Object.entries(sheets)
      .filter(([path]) => !RAW_COLOUR_ALLOWED.some((allowed) => path.includes(allowed)))
      .flatMap(([path, css]) =>
        css
          .split('\n')
          .map((line, index) => ({ line, index }))
          .filter(({ line }) => RAW_COLOUR.test(line) && !line.trim().startsWith('/*'))
          .map(({ line, index }) => `${path}:${index + 1} ${line.trim()}`),
      );
    expect(offenders).toEqual([]);
  });

  it('defines the device dark theme and the picked dark theme with the same values', () => {
    expect(values(darkMedia)).toEqual(values(darkPicked));
  });

  it('only redefines tokens that exist in the light theme', () => {
    const unknown = Object.keys(values(darkPicked)).filter((name) => !(name in light));
    expect(unknown).toEqual([]);
  });

  for (const [name, theme] of [
    ['light', light],
    ['dark', dark],
  ] as const) {
    it(`keeps AA text contrast in the ${name} theme`, () => {
      const failing = TEXT_PAIRS.map(([fg, bg]) => [fg, bg, contrast(theme, fg, bg)] as const)
        .filter(([, , ratio]) => ratio < 4.5)
        .map(([fg, bg, ratio]) => `${fg} on ${bg}: ${ratio.toFixed(2)}`);
      expect(failing).toEqual([]);
    });

    it(`keeps 3:1 contrast for interface marks in the ${name} theme`, () => {
      const failing = UI_PAIRS.map(([fg, bg]) => [fg, bg, contrast(theme, fg, bg)] as const)
        .filter(([, , ratio]) => ratio < 3)
        .map(([fg, bg, ratio]) => `${fg} on ${bg}: ${ratio.toFixed(2)}`);
      expect(failing).toEqual([]);
    });
  }
});
