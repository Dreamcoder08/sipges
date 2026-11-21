import { describe, expect, it } from 'vitest';
import { HOME_RANGE, MIN_ZOOM_DISTANCE, zoomLimits, zoomStep } from './zoom.ts';

describe('3D zoom limits', () => {
  it('keeps the camera between a close look and a few home frames away', () => {
    const limits = zoomLimits(40_000);
    expect(limits.minimum).toBe(MIN_ZOOM_DISTANCE);
    expect(limits.maximum).toBe(40_000 * HOME_RANGE * 3);
  });

  it('never lets the zoom-in button pass the closest distance', () => {
    const limits = zoomLimits(40_000);
    expect(zoomStep('in', 100_000, limits)).toBe(40_000);
    expect(zoomStep('in', 300, limits)).toBe(300 - MIN_ZOOM_DISTANCE);
    expect(zoomStep('in', MIN_ZOOM_DISTANCE, limits)).toBe(0);
  });

  it('never lets the zoom-out button pass the farthest distance', () => {
    const limits = zoomLimits(40_000);
    expect(zoomStep('out', 100_000, limits)).toBe(60_000);
    expect(zoomStep('out', limits.maximum - 1000, limits)).toBe(1000);
    expect(zoomStep('out', limits.maximum + 5000, limits)).toBe(0);
  });
});
