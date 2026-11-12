/// <reference types="node" />
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Guards for the design tokens (docs/adr/0018): modules use semantic tokens instead of raw
 * colours, both dark-theme blocks stay identical, and the text pairs every screen relies on
 * keep WCAG AA contrast in light and dark.
 */
// Vitest runs from the package directory (`pnpm --filter @sipges/web test`).
const SRC = join(process.cwd(), 'src/');
const sheets = Object.fromEntries(
  readdirSync(SRC, { recursive: true, encoding: 'utf8' })
    .filter((path) => path.endsWith('.css'))
    .map((path) => [`/${path.replaceAll('\\', '/')}`, readFileSync(`${SRC}${path}`, 'utf8')]),
);
const tokens = sheets['/app/styles/tokens.css'] ?? '';
/** Map paint written in TypeScript: it must read the --map-* tokens too (see engine/paint.ts). */
const mapSources = Object.fromEntries(
  readdirSync(SRC, { recursive: true, encoding: 'utf8' })
    .map((path) => path.replaceAll('\\', '/'))
    .filter((path) => path.startsWith('features/geography/') && /\.tsx?$/.test(path))
    .filter((path) => !/\.test\.tsx?$/.test(path))
    .map((path) => [`/${path}`, readFileSync(`${SRC}${path}`, 'utf8')]),
);

/** Only token definitions hold raw colours; map paint uses named --map-* tokens too. */
const RAW_COLOUR_ALLOWED = new Set(['/app/styles/tokens.css']);
const RAW_COLOUR = /#[0-9a-f]{3,8}\b|\brgba?\(|\bhsla?\(|:\s*(white|black)\s*;/i;

const rawColourOffenders = (entries: [string, string][]) =>
  entries
    .filter(([path]) => !RAW_COLOUR_ALLOWED.has(path))
    .flatMap(([path, css]) =>
      css
        .split('\n')
        .map((line, index) => ({ line, index }))
        .filter(({ line }) => RAW_COLOUR.test(line) && !line.trim().startsWith('/*'))
        .map(({ line, index }) => `${path}:${index + 1} ${line.trim()}`),
    );

/** Hex, rgb()/hsl() and Cesium `Color.WHITE`-style constants; `token-exempt: <reason>` allows a line. */
const RAW_PAINT = /#[0-9a-f]{3,8}\b|\b(?:rgba?|hsla?)\(/i;
const CESIUM_COLOUR = /\bColor\.[A-Z]{3,}\b/;
const PAINT_EXEMPT = /\/\/ token-exempt: \S/;

const rawPaintOffenders = (entries: [string, string][]) =>
  entries.flatMap(([path, source]) =>
    source
      .split('\n')
      .map((line, index) => ({ line, index }))
      .filter(({ line }) => !/^\s*(\/\/|\/?\*)/.test(line))
      .filter(
        ({ line }) =>
          (RAW_PAINT.test(line) || CESIUM_COLOUR.test(line)) && !PAINT_EXEMPT.test(line),
      )
      .map(({ line, index }) => `${path}:${index + 1} ${line.trim()}`),
  );

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

/** Follows `var(--alias)` to the colour it names, so aliases are checked like their targets. */
const resolve = (theme: Record<string, string>, name: string): string => {
  const value = theme[name] ?? name;
  const alias = /^var\((--[a-z0-9-]+)\)$/.exec(value);
  return alias?.[1] ? resolve(theme, alias[1]) : value;
};

const contrast = (
  theme: Record<string, string>,
  fg: string,
  bg: string,
  base = '--color-surface',
) => {
  const colour = (name: string) => parseColour(resolve(theme, name));
  const ground = over(colour(bg), colour(base));
  const ink = over(colour(fg), ground);
  const [hi, lo] = [luminance(ink), luminance(ground)].sort((a, b) => b - a) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
};

/** The ratio, or NaN when a token is missing or unparsable, so the failure names the pair. */
const ratio = (theme: Record<string, string>, fg: string, bg: string) => {
  try {
    return contrast(theme, fg, bg);
  } catch {
    return Number.NaN;
  }
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
  ['--color-on-primary', '--color-primary'],
  ['--color-on-primary', '--color-primary-hover'],
  ['--color-text', '--color-sidebar'],
  ['--color-muted', '--color-sidebar'],
  ['--color-text', '--color-surface-raised'],
  ['--color-muted', '--color-fill'],
  ['--map-text', '--map-land'],
  ['--map-label-sea', '--map-sea'],
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
  ['--color-on-strong', '--dim-d'],
  ['--color-success', '--color-success-soft'],
  ['--tone-warning-fg', '--color-warning-soft'],
  ['--ink-strong', '--canvas'],
  ['--ink-soft', '--canvas'],
  // The ground the artboards measured for faint diagram ink (#161618 in dark).
  ['--ink-faint', '--color-surface-raised'],
];

/** Interface marks (focus ring, accent, selected tab): 3:1 against the surface. */
const UI_PAIRS: [string, string][] = [
  ['--color-focus', '--color-surface'],
  ['--color-accent', '--color-surface'],
  ['--color-brand', '--color-surface'],
  ['--color-primary', '--color-bg'],
  ['--map-ink', '--map-land'],
  // Edges of inputs, selects, textareas and secondary buttons, on the page and on fills.
  ['--color-control-border', '--color-bg'],
  ['--color-control-border', '--color-surface'],
  ['--color-control-border', '--color-fill'],
  ['--color-warning', '--color-surface'],
  ['--level-yellow', '--color-surface'],
  ['--viz-6', '--color-surface'],
];

/** Literals that have a token: the pill radius, the touch target, stacking and spinner timing. */
const RETIRED_LITERAL = /\b999px\b|\b44px\b|z-index:\s*\d{3}|animation:[^;]*\b\d*\.?\d+m?s\b/;

const retiredLiteralOffenders = (entries: [string, string][]) =>
  entries
    .filter(([path]) => !RAW_COLOUR_ALLOWED.has(path))
    .flatMap(([path, css]) =>
      css
        .split('\n')
        .map((line, index) => ({ line, index }))
        .filter(({ line }) => RETIRED_LITERAL.test(line) && !/^\s*(\/\*|\*)/.test(line))
        .map(({ line, index }) => `${path}:${index + 1} ${line.trim()}`),
    );

/** The value a selector gives a property in a stylesheet, or undefined. */
const declared = (css: string, selector: string, property: string) => {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const rule = new RegExp(`(?:^|\\n)${escaped}\\s*\\{([^}]*)\\}`).exec(css)?.[1] ?? '';
  return new RegExp(`(?:^|;|\\s)${property}:\\s*([^;]+);`).exec(rule)?.[1]?.trim();
};

describe('design tokens', () => {
  it('keeps raw colours out of modules', () => {
    expect(rawColourOffenders(Object.entries(sheets))).toEqual([]);
  });

  it('exempts only the token definition stylesheet', () => {
    const css = '.control { color: #abc; }';
    expect(
      rawColourOffenders([
        ['/app/styles/tokens.css', css],
        ['/features/geography/Geography.module.css', css],
        ['/features/geography/TerritorialMap.module.css', css],
        ['/features/geography/Controls.module.css', css],
        ['/features/records/Controls.module.css', css],
        ['/features/other/geography/Geography.module.css', css],
        ['/features/geography/Geography.module.css.extra.css', css],
        ['/other/styles/tokens.css', css],
      ]),
    ).toEqual([
      `/features/geography/Geography.module.css:1 ${css}`,
      `/features/geography/TerritorialMap.module.css:1 ${css}`,
      `/features/geography/Controls.module.css:1 ${css}`,
      `/features/records/Controls.module.css:1 ${css}`,
      `/features/other/geography/Geography.module.css:1 ${css}`,
      `/features/geography/Geography.module.css.extra.css:1 ${css}`,
      `/other/styles/tokens.css:1 ${css}`,
    ]);
    expect(
      rawColourOffenders([
        ['/features/geography/Controls.module.css', '.control { color: var(--color-text); }'],
      ]),
    ).toEqual([]);
  });

  it('keeps raw colours out of map paint written in TypeScript', () => {
    expect(Object.keys(mapSources).length).toBeGreaterThan(10);
    expect(rawPaintOffenders(Object.entries(mapSources))).toEqual([]);
  });

  it('allows a raw colour in map TypeScript only with a stated reason', () => {
    expect(
      rawPaintOffenders([
        [
          '/features/geography/x.tsx',
          [
            "const a = '#abc';",
            "const b = 'rgb(1 2 3)'; // token-exempt: official legend colour",
            "const c = 'rgba(1, 2, 3, 1)'; // token-exempt:",
            'const d = Color.WHITE;',
            "// const e = '#abc'",
            "const f = 'var(--map-bg)';",
          ].join('\n'),
        ],
      ]),
    ).toEqual([
      "/features/geography/x.tsx:1 const a = '#abc';",
      "/features/geography/x.tsx:3 const c = 'rgba(1, 2, 3, 1)'; // token-exempt:",
      '/features/geography/x.tsx:4 const d = Color.WHITE;',
    ]);
  });

  it('defines the device dark theme and the picked dark theme with the same values', () => {
    expect(values(darkMedia)).toEqual(values(darkPicked));
  });

  it('raises every control size to the 44px touch target on touch screens (WCAG 2.5.5)', () => {
    // Chips, toggles and icon buttons size themselves with --control-*; one rule covers them all.
    const coarse = block(/@media \(pointer: coarse\) \{\s*:root \{([\s\S]*?)^ {2}\}/m);
    expect(values(coarse)).toEqual({
      '--control-sm': 'var(--touch-target)',
      '--control-md': 'var(--touch-target)',
    });
    expect(light['--touch-target']).toBe('2.75rem');
  });

  it('defines the caption size, spinner and shimmer timing and the warning alias', () => {
    expect(light['--text-caption']).toBe('0.75rem');
    expect(light['--motion-spin']).toBe('800ms');
    expect(light['--motion-shimmer']).toBe('1400ms');
    expect(light['--color-warning']).toBe('var(--tone-warning-solid)');
    expect(light['--color-warning-soft']).toBe('var(--tone-warning-bg)');
    expect(resolve(dark, '--color-warning')).toBe('#c99a3a');
  });

  it('keeps the corrected mark colours: darker in light, unchanged in dark', () => {
    expect(light['--dim-d']).toBe('#92600f');
    expect([light['--level-yellow'], light['--viz-6']]).toEqual(['#a87a12', '#a87a12']);
    expect([dark['--level-yellow'], dark['--viz-6']]).toEqual(['#d69e2e', '#d69e2e']);
    expect([light['--color-control-border'], dark['--color-control-border']]).toEqual([
      '#858585',
      '#707075',
    ]);
    expect(dark['--ink-faint']).toBe('#8f8f8f');
  });

  it('edges form controls and secondary buttons with --color-control-border', () => {
    const global = sheets['/app/styles/global.css'] ?? '';
    const button = sheets['/shared/ui/Button.module.css'] ?? '';
    expect(declared(global, 'input,\nselect,\ntextarea', 'border')).toBe(
      '1px solid var(--color-control-border)',
    );
    expect(declared(button, '.secondary', 'border-color')).toBe('var(--color-control-border)');
  });

  it('stacks the confirmation dialog on tokens above sheets', () => {
    const dialog = sheets['/shared/ui/ConfirmDialog.module.css'] ?? '';
    expect(declared(dialog, '.backdrop', 'z-index')).toBe('var(--z-dialog)');
    expect(declared(dialog, '.dialog', 'z-index')).toBe('calc(var(--z-dialog) + 1)');
    expect(Number(light['--z-dialog'])).toBeGreaterThan(Number(light['--z-skip']));
    expect(Number(light['--z-skip'])).toBeGreaterThan(Number(light['--z-modal']));
  });

  it('uses the token instead of 999px, 44px, three-digit z-index or literal animation timing', () => {
    expect(retiredLiteralOffenders(Object.entries(sheets))).toEqual([]);
    expect(
      retiredLiteralOffenders([
        ['/x.module.css', '.a { border-radius: 999px; }\n/* 44px target */\n.b { z-index: 100; }'],
        ['/y.module.css', '.c { animation: spin 0.8s linear infinite; }\n.d { z-index: 2; }'],
        ['/z.module.css', '.e { animation: spin var(--motion-spin) linear infinite; }'],
      ]),
    ).toEqual([
      '/x.module.css:1 .a { border-radius: 999px; }',
      '/x.module.css:3 .b { z-index: 100; }',
      '/y.module.css:1 .c { animation: spin 0.8s linear infinite; }',
    ]);
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
      const failing = TEXT_PAIRS.map(([fg, bg]) => [fg, bg, ratio(theme, fg, bg)] as const)
        .filter(([, , ratio]) => !(ratio >= 4.5))
        .map(([fg, bg, ratio]) => `${fg} on ${bg}: ${ratio.toFixed(2)}`);
      expect(failing).toEqual([]);
    });

    it(`keeps 3:1 contrast for interface marks in the ${name} theme`, () => {
      const failing = UI_PAIRS.map(([fg, bg]) => [fg, bg, ratio(theme, fg, bg)] as const)
        .filter(([, , ratio]) => !(ratio >= 3))
        .map(([fg, bg, ratio]) => `${fg} on ${bg}: ${ratio.toFixed(2)}`);
      expect(failing).toEqual([]);
    });
  }
});
