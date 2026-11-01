import type { ReactNode } from 'react';
import { SECHURA_DISTRICTS, SECHURA_LABELS, SECHURA_PLACES, type LonLat } from './sechura-base.ts';
import styles from './Geography.module.css';

export type Extent = readonly [number, number, number, number];

/**
 * SVG user units per degree (about 1.1 m each). Drawing in raw degrees gave a viewBox
 * 0.06 wide and font sizes near 0.002 once a concession was framed; mobile browsers clamp
 * such text to a minimum size, so labels and the north arrow covered the map in dark ink.
 */
export const UNITS_PER_DEGREE = 100_000;

/** Longitude to SVG x. */
export const svgX = (lon: number) => lon * UNITS_PER_DEGREE;
/** Latitude to SVG y (negated so north is up). */
export const svgY = (lat: number) => -lat * UNITS_PER_DEGREE;

/** SVG path of lon/lat rings in map units. */
export const ringsPath = (rings: readonly (readonly LonLat[])[]) =>
  rings
    .map(
      (points) =>
        points.map(([lon, lat], i) => `${i ? 'L' : 'M'} ${svgX(lon)} ${svgY(lat)}`).join(' ') +
        ' Z',
    )
    .join(' ');

/** Smallest extent holding both, used to frame the province and the project together. */
export const unionExtent = (a: Extent, b: Extent): Extent => [
  Math.min(a[0], b[0]),
  Math.min(a[1], b[1]),
  Math.max(a[2], b[2]),
  Math.max(a[3], b[3]),
];

export const intersects = (a: Extent, b: Extent) =>
  a[0] <= b[2] && b[0] <= a[2] && a[1] <= b[3] && b[1] <= a[3];

const KM_PER_DEGREE = 111.32;
const SCALE_STEPS = [0.5, 1, 2, 5, 10, 20, 50, 100];

/**
 * Province base map in geographic coordinates: sea, generalised districts, reference towns,
 * north arrow and a scale bar sized to the current view. `children` draw on top in the same
 * map space (`svgX`, `svgY`, `ringsPath`: concessions, highlights).
 */
export const BaseMap = ({
  view,
  label,
  title,
  districtClass,
  districtProps,
  showBase = true,
  background,
  imagery = false,
  describedBy,
  children,
}: {
  /** Visible [minLon, minLat, maxLon, maxLat]. */
  view: Extent;
  label: string;
  title: string;
  districtClass?: (name: string) => string;
  districtProps?: (name: string) => Record<string, unknown>;
  /** False outside the province: only the overlay, scale and north arrow are drawn. */
  showBase?: boolean;
  /** Raster basemap drawn over the vector land; district outlines stay on top. */
  background?: ReactNode;
  /** The background is imagery: light outlines, and town names stay drawn over it. */
  imagery?: boolean;
  /** Id of the gesture hint; makes the map focusable for keyboard panning and zoom. */
  describedBy?: string;
  children?: ReactNode;
}) => {
  const [minX, minY, maxX, maxY] = view.map((v) => v * UNITS_PER_DEGREE) as unknown as Extent;
  const width = maxX - minX;
  const height = maxY - minY;
  const unit = height / 100;
  const widthKm = (view[2] - view[0]) * KM_PER_DEGREE * 0.22;
  const km = SCALE_STEPS.reduce((best, step) =>
    Math.abs(step - widthKm) < Math.abs(best - widthKm) ? step : best,
  );
  const scaleLength = (km / KM_PER_DEGREE) * UNITS_PER_DEGREE;
  const left = minX + width * 0.04;
  const bottom = -minY - unit * 5;
  const arrowX = maxX - width * 0.06;
  const arrowY = -maxY + unit * 6;
  return (
    <svg
      className={`${styles.map} ${imagery ? styles.imagery : ''}`}
      viewBox={`${minX} ${-maxY} ${width} ${height}`}
      preserveAspectRatio="xMidYMid meet"
      role="group"
      aria-label={label}
      tabIndex={describedBy ? 0 : undefined}
      aria-describedby={describedBy}
    >
      <title>{title}</title>
      {/* Everything that moves with the map; gestures transform this group between renders. */}
      <g data-map-content="">
        {/* Explicit token fills: shapes must not fall back to black if the module class is missing. */}
        <rect
          className={styles.sea}
          fill="var(--map-sea)"
          x={minX - width}
          y={-maxY - height}
          width={width * 3}
          height={height * 3}
        />
        {showBase ? (
          <g>
            {SECHURA_DISTRICTS.map((district) => (
              <path
                key={district.name}
                className={`${styles.district} ${districtClass?.(district.name) ?? ''}`}
                fill="var(--map-land)"
                stroke="var(--map-line)"
                d={ringsPath([district.ring])}
                strokeWidth={unit * 0.35}
                {...districtProps?.(district.name)}
              />
            ))}
          </g>
        ) : null}
        {background}
        {showBase && background ? (
          <g aria-hidden="true">
            {SECHURA_DISTRICTS.map((district) => (
              <path
                key={district.name}
                className={styles.outline}
                d={ringsPath([district.ring])}
                strokeWidth={unit * (imagery ? 0.4 : 0.3)}
                // Dashes sized to the view: a fixed CSS dash in map units (about 1 m) made
                // millions of dashes per district and froze every frame of a drag.
                strokeDasharray={`${unit * 1.2} ${unit * 0.8}`}
              />
            ))}
          </g>
        ) : null}
        {showBase ? (
          <g aria-hidden="true" display={background ? 'none' : undefined}>
            {SECHURA_LABELS.map((item) => (
              <text
                key={item.text}
                className={item.kind === 'sea' ? styles.seaLabel : styles.areaLabel}
                x={svgX(item.at[0])}
                y={svgY(item.at[1])}
                fontSize={unit * 2.8}
                textAnchor="middle"
              >
                {item.text}
              </text>
            ))}
          </g>
        ) : null}
        {children}
        <g aria-hidden="true" display={showBase && (!background || imagery) ? undefined : 'none'}>
          {SECHURA_PLACES.map((place) => (
            <g key={place.name}>
              <circle
                className={place.kind === 'port' ? styles.port : styles.town}
                cx={svgX(place.at[0])}
                cy={svgY(place.at[1])}
                r={unit * 0.9}
                strokeWidth={unit * 0.3}
              />
              <text
                className={styles.placeLabel}
                x={svgX(place.at[0]) + unit * 1.4}
                y={svgY(place.at[1]) + unit * 1}
                fontSize={unit * 2.8}
                strokeWidth={unit * 0.5}
              >
                {place.name}
              </text>
            </g>
          ))}
        </g>
      </g>
      <g aria-hidden="true" className={styles.furniture}>
        <path
          d={`M ${arrowX} ${arrowY - unit * 4} L ${arrowX + unit * 1.6} ${arrowY + unit * 1.5} L ${arrowX} ${arrowY + unit * 0.6} L ${arrowX - unit * 1.6} ${arrowY + unit * 1.5} Z`}
        />
        <text x={arrowX} y={arrowY + unit * 5} fontSize={unit * 2.8} textAnchor="middle">
          N
        </text>
        <rect
          x={left}
          y={bottom - unit * 0.6}
          width={scaleLength}
          height={unit * 1.2}
          strokeWidth={unit * 0.2}
          className={styles.scale}
        />
        <text x={left} y={bottom - unit * 1.6} fontSize={unit * 2.6}>
          {km < 1 ? `${km * 1000} m` : `${km} km`}
        </text>
      </g>
    </svg>
  );
};
