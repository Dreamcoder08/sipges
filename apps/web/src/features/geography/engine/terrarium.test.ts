import { describe, expect, it } from 'vitest';
import { sampleHeights, sourceTile, terrariumHeight } from './terrarium.ts';

/** A size × size Terrarium tile whose height is `at(px, py)` metres. */
const tile = (size: number, at: (px: number, py: number) => number) => {
  const rgba = new Uint8ClampedArray(size * size * 4);
  for (let py = 0; py < size; py += 1)
    for (let px = 0; px < size; px += 1) {
      const v = at(px, py) + 32768;
      const i = (py * size + px) * 4;
      rgba[i] = Math.floor(v / 256);
      rgba[i + 1] = Math.floor(v % 256);
      rgba[i + 2] = Math.round((v % 1) * 256);
      rgba[i + 3] = 255;
    }
  return rgba;
};

describe('Terrarium elevation', () => {
  it('decodes metres from the three colour channels', () => {
    expect(terrariumHeight(128, 0, 0)).toBe(0);
    expect(terrariumHeight(128, 100, 128)).toBe(100.5);
    expect(terrariumHeight(127, 156, 0)).toBe(-100);
  });

  it('cuts deeper terrain tiles from their ancestor at the deepest level fetched', () => {
    expect(sourceTile(5, 7, 3, 14)).toEqual({ z: 3, x: 5, y: 7, scale: 1, offsetX: 0, offsetY: 0 });
    expect(sourceTile(4 * 9 + 3, 4 * 2 + 1, 16, 14)).toEqual({
      z: 14,
      x: 9,
      y: 2,
      scale: 0.25,
      offsetX: 0.75,
      offsetY: 0.25,
    });
  });

  it('samples a heightmap north row first, interpolating between pixels', () => {
    // Height grows eastwards with x and southwards with y.
    const rgba = tile(5, (px, py) => px * 10 + py * 100);
    const whole = sampleHeights(rgba, 5, { scale: 1, offsetX: 0, offsetY: 0 }, 3);
    expect([...whole]).toEqual([0, 20, 40, 200, 220, 240, 400, 420, 440]);
    const quarter = sampleHeights(rgba, 5, { scale: 0.5, offsetX: 0.5, offsetY: 0 }, 2);
    expect([...quarter]).toEqual([20, 40, 220, 240]);
  });
});
