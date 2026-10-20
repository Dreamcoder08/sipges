/**
 * Open elevation tiles of the AWS Registry of Open Data (Mapzen Terrain Tiles, Terrarium
 * encoding, Web Mercator z/x/y), read by the 3D terrain view (ADR 0026). No key or account.
 */
export const RELIEF = {
  url: (z: number, x: number, y: number) =>
    `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${z}/${x}/${y}.png`,
  /** Deepest level fetched; deeper terrain tiles are cut from their ancestor at this level. */
  maxZoom: 14,
  size: 256,
  attribution: {
    text: 'Terrain Tiles (Mapzen, AWS Open Data; SRTM y otras fuentes)',
    href: 'https://github.com/tilezen/joerd/blob/master/docs/attribution.md',
  },
} as const;

/** Heights per side of a terrain tile handed to CesiumJS (edges included). */
export const GRID = 65;

/** Metres above sea level of one Terrarium pixel. */
export const terrariumHeight = (r: number, g: number, b: number) => r * 256 + g + b / 256 - 32768;

/** The tile at `maxZoom` or above that holds terrain tile x/y/level, and where inside it. */
export const sourceTile = (
  x: number,
  y: number,
  level: number,
  maxZoom: number = RELIEF.maxZoom,
) => {
  const z = Math.min(level, maxZoom);
  const span = 2 ** (level - z);
  return {
    z,
    x: Math.floor(x / span),
    y: Math.floor(y / span),
    /** Fraction of the source tile this terrain tile covers, and its offset, per axis. */
    scale: 1 / span,
    offsetX: (x % span) / span,
    offsetY: (y % span) / span,
  };
};

/**
 * Samples a GRID × GRID heightmap (north row first) from decoded Terrarium RGBA pixels,
 * covering the window `scale` wide at (`offsetX`, `offsetY`) of the source tile, with
 * bilinear interpolation between pixels.
 */
export const sampleHeights = (
  rgba: Uint8ClampedArray,
  size: number,
  window: { scale: number; offsetX: number; offsetY: number },
  grid: number = GRID,
) => {
  const height = (px: number, py: number) => {
    const i = (py * size + px) * 4;
    return terrariumHeight(rgba[i] ?? 0, rgba[i + 1] ?? 0, rgba[i + 2] ?? 0);
  };
  const out = new Float32Array(grid * grid);
  for (let row = 0; row < grid; row += 1)
    for (let col = 0; col < grid; col += 1) {
      const fx = (window.offsetX + (col / (grid - 1)) * window.scale) * (size - 1);
      const fy = (window.offsetY + (row / (grid - 1)) * window.scale) * (size - 1);
      const x0 = Math.floor(fx);
      const y0 = Math.floor(fy);
      const x1 = Math.min(x0 + 1, size - 1);
      const y1 = Math.min(y0 + 1, size - 1);
      const tx = fx - x0;
      const ty = fy - y0;
      const top = height(x0, y0) * (1 - tx) + height(x1, y0) * tx;
      const bottom = height(x0, y1) * (1 - tx) + height(x1, y1) * tx;
      out[row * grid + col] = top * (1 - ty) + bottom * ty;
    }
  return out;
};
