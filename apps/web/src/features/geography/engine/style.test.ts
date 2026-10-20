import { describe, expect, it } from 'vitest';
import { RELIEF, styleFor } from './style.ts';

describe('styleFor', () => {
  it('draws no relief in the flat view', () => {
    const style = styleFor('calles');
    expect(Object.keys(style.sources)).toEqual(['base']);
    expect(style.layers.map((l) => l.id)).toEqual(['fondo', 'base']);
  });

  it('shades open elevation tiles over the basemap in the 3D view, without raising the ground', () => {
    const style = styleFor('satelite', 'dark', true);
    expect(style.sources.relieve).toMatchObject({
      type: 'raster-dem',
      encoding: 'terrarium',
      tiles: [RELIEF.url],
    });
    expect(style.layers.map((l) => l.id)).toEqual(['fondo', 'base', 'relieve']);
    expect(style.layers.at(-1)?.type).toBe('hillshade');
    expect(style.terrain).toBeUndefined();
    expect(styleFor('ninguno', 'light', true).layers.map((l) => l.id)).toEqual([
      'fondo',
      'relieve',
    ]);
  });
});
