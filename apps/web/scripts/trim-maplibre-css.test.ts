import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { trimMaplibreCss } from './trim-maplibre-css.ts';

const real = readFileSync(
  createRequire(import.meta.url).resolve('maplibre-gl/dist/maplibre-gl.css'),
  'utf8',
);

describe('trimMaplibreCss', () => {
  it('drops rules that only style controls the map never adds', () => {
    const css =
      '.maplibregl-canvas{position:absolute}' +
      '.maplibregl-ctrl-logo{background-image:url("data:image/svg+xml;x")}' +
      '.maplibregl-ctrl button.maplibregl-ctrl-zoom-in .maplibregl-ctrl-icon,.maplibregl-ctrl-compass-arrow{x:1}' +
      '@media(forced-colors:active){.maplibregl-ctrl-geolocate .maplibregl-ctrl-icon{y:2}.maplibregl-ctrl-group{z:3}}';
    expect(trimMaplibreCss(css)).toBe(
      '.maplibregl-canvas{position:absolute}@media(forced-colors:active){.maplibregl-ctrl-group{z:3}}',
    );
  });

  it('keeps a rule when one of its selectors is still used', () => {
    const kept =
      '.maplibregl-ctrl-group button.maplibregl-ctrl-compass,.maplibregl-canvas-container{cursor:grab}';
    expect(trimMaplibreCss(`${kept}.maplibregl-ctrl-logo{x:1}`)).toBe(kept);
  });

  it('keeps what the map uses: the map, canvas, popups, markers, control corners and keyframes', () => {
    const trimmed = trimMaplibreCss(real);
    for (const used of [
      '.maplibregl-map{',
      '.maplibregl-canvas{',
      '.maplibregl-popup',
      '.maplibregl-marker',
      '.maplibregl-ctrl-top-right',
      '@keyframes maplibregl-spin',
    ]) {
      expect(trimmed).toContain(used);
    }
    expect(trimmed).not.toContain('maplibregl-ctrl-logo');
    expect(trimmed).not.toContain('data:image/svg+xml');
    expect(trimmed.length).toBeLessThan(real.length / 4);
  });

  it('fails when an upgrade leaves nothing to drop, so the build notices', () => {
    expect(() => trimMaplibreCss('.maplibregl-canvas{position:absolute}')).toThrow(
      /maplibre-gl\.css/,
    );
  });
});
