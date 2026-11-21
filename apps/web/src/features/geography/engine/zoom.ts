/** Home frame distance, as a multiple of the framed extent's bounding radius. */
export const HOME_RANGE = 2.6;
/** Closest the 3D camera may get to the ground, in metres: closer, the tiles turn into a grey blur. */
export const MIN_ZOOM_DISTANCE = 250;

export interface ZoomLimits {
  readonly minimum: number;
  readonly maximum: number;
}

/**
 * Distances the 3D camera may move between, so the wheel cannot fly it into the ground or out into
 * empty space where the province is lost: at most three home frames away.
 */
export const zoomLimits = (homeRadius: number): ZoomLimits => ({
  minimum: MIN_ZOOM_DISTANCE,
  maximum: homeRadius * HOME_RANGE * 3,
});

/** How far one press of «Acercar» or «Alejar» moves the camera from `height`, kept within the limits. */
export const zoomStep = (direction: 'in' | 'out', height: number, limits: ZoomLimits) =>
  direction === 'in'
    ? Math.max(0, Math.min(height * 0.4, height - limits.minimum))
    : Math.max(0, Math.min(height * 0.6, limits.maximum - height));
