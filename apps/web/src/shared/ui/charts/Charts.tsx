import { type ReactNode, useEffect, useState } from 'react';
import styles from './Charts.module.css';

/**
 * Dependency-free SVG charts. Every chart carries its numbers in text (a legend or a hidden
 * table) for screen readers; the drawing itself is decoration (aria-hidden). Colours come from
 * CSS classes, so the strict CSP needs no inline styles.
 */

export type Datum = { key: string; label: string; value: number; tone?: string };

/**
 * Width of the chart's box in CSS pixels, so axis text keeps its real size at any width
 * (a fixed viewBox would scale 11px labels up to 30px on a wide card).
 */
const useWidth = (fallback: number) => {
  const [node, setNode] = useState<SVGSVGElement | null>(null);
  const [width, setWidth] = useState(fallback);
  useEffect(() => {
    if (!node || typeof ResizeObserver === 'undefined') return;
    let frame: number | undefined;
    const observer = new ResizeObserver(([entry]) => {
      const next = Math.round(entry?.contentRect.width ?? 0);
      if (next <= 0) return;
      if (frame !== undefined) cancelAnimationFrame(frame);
      // The viewBox changes this observed SVG's auto height. Defer the write until
      // the next frame so WebKit can finish delivering the current resize batch.
      frame = requestAnimationFrame(() => {
        frame = undefined;
        setWidth(next);
      });
    });
    observer.observe(node);
    return () => {
      observer.disconnect();
      if (frame !== undefined) cancelAnimationFrame(frame);
    };
  }, [node]);
  return [setNode, width] as const;
};

const tone = (name?: string) => (name ? (styles[name] ?? '') : '');

// A table ignores `width: 1px` and keeps its content width, which widened phone pages;
// the hiding wrapper clips it instead.
const DataTable = ({ caption, data }: { caption: string; data: readonly Datum[] }) => (
  <div className="visually-hidden">
    <table>
      <caption>{caption}</caption>
      <tbody>
        {data.map((d) => (
          <tr key={d.key}>
            <th scope="row">{d.label}</th>
            <td>{d.value}</td>
          </tr>
        ))}
      </tbody>
    </table>
  </div>
);

/** A "nice" upper bound for an axis (1, 2, 5 × 10ⁿ). */
export const niceMax = (value: number) => {
  if (value <= 0) return 1;
  const power = 10 ** Math.floor(Math.log10(value));
  const step = [1, 2, 5, 10].find((n) => n * power >= value) ?? 10;
  return step * power;
};

/** Ring chart with the total in the middle and a legend with each count. */
export const DonutChart = ({
  data,
  caption,
  totalLabel,
  empty,
}: {
  data: readonly Datum[];
  caption: string;
  totalLabel: string;
  empty: string;
}) => {
  const total = data.reduce((sum, d) => sum + d.value, 0);
  const radius = 42;
  const circumference = 2 * Math.PI * radius;
  let offset = 0;
  return (
    <figure className={styles.figure}>
      <div className={styles.donutLayout}>
        <svg className={styles.svg} viewBox="0 0 120 120" aria-hidden="true">
          <circle className={styles.donutTrack} cx="60" cy="60" r={radius} strokeWidth="16" />
          {total
            ? data
                .filter((d) => d.value > 0)
                .map((d) => {
                  const length = (d.value / total) * circumference;
                  const segment = (
                    <circle
                      key={d.key}
                      className={tone(d.tone)}
                      cx="60"
                      cy="60"
                      r={radius}
                      fill="none"
                      strokeWidth="16"
                      strokeDasharray={`${length} ${circumference - length}`}
                      strokeDashoffset={-offset}
                      transform="rotate(-90 60 60)"
                    />
                  );
                  offset += length;
                  return segment;
                })
            : null}
          <text className={styles.donutTotal} x="60" y="64" textAnchor="middle">
            {total}
          </text>
          <text className={styles.donutCaption} x="60" y="80" textAnchor="middle">
            {totalLabel}
          </text>
        </svg>
        <dl className={styles.legend} aria-label={caption}>
          {data.map((d) => (
            <div key={d.key}>
              <dt>
                <span className={`${styles.swatch} ${tone(d.tone)}`} aria-hidden="true" />
                <span>{d.label}</span>
              </dt>
              <dd>{d.value}</dd>
            </div>
          ))}
        </dl>
      </div>
      {total ? null : <p className={styles.empty}>{empty}</p>}
    </figure>
  );
};

/** Vertical bars over labelled categories (e.g. months). */
export const ColumnChart = ({
  data,
  caption,
  empty,
}: {
  data: readonly Datum[];
  caption: string;
  empty: string;
}) => {
  const [ref, width] = useWidth(320);
  if (!data.length || data.every((d) => d.value === 0))
    return <p className={styles.empty}>{empty}</p>;
  const height = 180;
  const left = 26;
  const bottom = 22;
  const top = 14;
  const max = niceMax(Math.max(...data.map((d) => d.value)));
  const slot = (width - left) / data.length;
  const bar = Math.min(44, slot * 0.6);
  const y = (v: number) => top + (height - top - bottom) * (1 - v / max);
  return (
    <figure className={styles.figure}>
      <svg ref={ref} className={styles.svg} viewBox={`0 0 ${width} ${height}`} aria-hidden="true">
        {[0, 0.5, 1].map((f) => (
          <g key={f}>
            <line className={styles.grid} x1={left} x2={width} y1={y(max * f)} y2={y(max * f)} />
            <text className={styles.tick} x={left - 6} y={y(max * f) + 4} textAnchor="end">
              {Math.round(max * f)}
            </text>
          </g>
        ))}
        {data.map((d, i) => {
          const x = left + slot * i + (slot - bar) / 2;
          return (
            <g key={d.key}>
              <rect
                className={`${styles.bar} ${tone(d.tone)}`}
                x={x}
                y={y(d.value)}
                width={bar}
                height={Math.max(0, y(0) - y(d.value))}
                rx="3"
              />
              {d.value ? (
                <text
                  className={styles.value}
                  x={x + bar / 2}
                  y={y(d.value) - 4}
                  textAnchor="middle"
                >
                  {d.value}
                </text>
              ) : null}
              <text className={styles.tick} x={x + bar / 2} y={height - 6} textAnchor="middle">
                {d.label}
              </text>
            </g>
          );
        })}
      </svg>
      <DataTable caption={caption} data={data} />
    </figure>
  );
};

/** Line over time with a soft area (e.g. IRSA snapshots), on a fixed 0–max scale. */
export const LineChart = ({
  data,
  caption,
  empty,
  max = 100,
}: {
  data: readonly Datum[];
  caption: string;
  empty: string;
  max?: number;
}) => {
  const [ref, width] = useWidth(320);
  if (data.length < 2) return <p className={styles.empty}>{empty}</p>;
  const height = 180;
  const left = 30;
  const right = 10;
  const bottom = 22;
  const top = 14;
  const x = (i: number) => left + ((width - left - right) * i) / (data.length - 1);
  const y = (v: number) => top + (height - top - bottom) * (1 - v / max);
  const points = data.map((d, i) => `${x(i)},${y(d.value)}`).join(' ');
  const every = Math.ceil(data.length / 6);
  return (
    <figure className={styles.figure}>
      <svg ref={ref} className={styles.svg} viewBox={`0 0 ${width} ${height}`} aria-hidden="true">
        {[0, 0.5, 1].map((f) => (
          <g key={f}>
            <line
              className={styles.grid}
              x1={left}
              x2={width - right}
              y1={y(max * f)}
              y2={y(max * f)}
            />
            <text className={styles.tick} x={left - 6} y={y(max * f) + 4} textAnchor="end">
              {Math.round(max * f)}
            </text>
          </g>
        ))}
        <polygon
          className={styles.area}
          points={`${x(0)},${y(0)} ${points} ${x(data.length - 1)},${y(0)}`}
        />
        <polyline className={styles.line} points={points} />
        {data.map((d, i) => (
          <g key={d.key}>
            <circle className={styles.dot} cx={x(i)} cy={y(d.value)} r="3.5" />
            {i % every === 0 || i === data.length - 1 ? (
              <text className={styles.tick} x={x(i)} y={height - 6} textAnchor="middle">
                {d.label}
              </text>
            ) : null}
          </g>
        ))}
      </svg>
      <DataTable caption={caption} data={data} />
    </figure>
  );
};

export type Series = { key: string; label: string; tone: string; values: readonly number[] };

/**
 * Several lines over the same labelled x axis (e.g. narratives per day and category), with a
 * legend under the drawing and every value in a hidden table.
 */
export const MultiLineChart = ({
  labels,
  series,
  caption,
  empty,
  yTitle,
}: {
  labels: readonly string[];
  series: readonly Series[];
  caption: string;
  empty: string;
  yTitle?: string;
}) => {
  const [ref, width] = useWidth(640);
  const peak = Math.max(0, ...series.flatMap((s) => s.values));
  if (labels.length < 2 || peak === 0) return <p className={styles.empty}>{empty}</p>;
  const height = 240;
  const left = yTitle ? 44 : 30;
  const right = 12;
  const bottom = 24;
  const top = 12;
  const max = niceMax(peak);
  const x = (i: number) => left + ((width - left - right) * i) / (labels.length - 1);
  const y = (v: number) => top + (height - top - bottom) * (1 - v / max);
  // About one x label per 70px, so dates never overlap on a phone.
  const every = Math.max(1, Math.ceil(labels.length / Math.max(2, Math.floor(width / 70))));
  // niceMax gives 1, 2 or a multiple of 5: whole-number gridlines at every step.
  const steps = max <= 2 ? max : 5;
  const ticks = Array.from({ length: steps + 1 }, (_, n) => n / steps);
  const dots = labels.length <= 45;
  return (
    <figure className={styles.figure}>
      <svg ref={ref} className={styles.svg} viewBox={`0 0 ${width} ${height}`} aria-hidden="true">
        {ticks.map((f) => (
          <g key={f}>
            <line
              className={styles.grid}
              x1={left}
              x2={width - right}
              y1={y(max * f)}
              y2={y(max * f)}
            />
            <text className={styles.tick} x={left - 6} y={y(max * f) + 4} textAnchor="end">
              {Math.round(max * f)}
            </text>
          </g>
        ))}
        {yTitle ? (
          <text
            className={styles.tick}
            transform={`translate(11 ${top + (height - top - bottom) / 2}) rotate(-90)`}
            textAnchor="middle"
          >
            {yTitle}
          </text>
        ) : null}
        {labels.map((label, i) =>
          i % every === 0 ? (
            <text key={label} className={styles.tick} x={x(i)} y={height - 6} textAnchor="middle">
              {label}
            </text>
          ) : null,
        )}
        {series.map((s) => (
          <g key={s.key} className={tone(s.tone)}>
            <polyline
              className={styles.seriesLine}
              points={s.values.map((v, i) => `${x(i)},${y(v)}`).join(' ')}
            />
            {dots
              ? s.values.map((v, i) => (
                  <circle key={i} className={styles.seriesDot} cx={x(i)} cy={y(v)} r="3.5" />
                ))
              : null}
          </g>
        ))}
      </svg>
      <ul className={styles.seriesLegend} aria-hidden="true">
        {series.map((s) => (
          <li key={s.key}>
            <span className={`${styles.swatch} ${styles.round} ${tone(s.tone)}`} />
            {s.label}
          </li>
        ))}
      </ul>
      <div className="visually-hidden">
        <table>
          <caption>{caption}</caption>
          <thead>
            <tr>
              <th scope="col">Fecha</th>
              {series.map((s) => (
                <th key={s.key} scope="col">
                  {s.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {labels.map((label, i) => (
              <tr key={label}>
                <th scope="row">{label}</th>
                {series.map((s) => (
                  <td key={s.key}>{s.values[i] ?? 0}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </figure>
  );
};

/** Spider chart over a shared 0–max scale (e.g. the six G-A-D-N-E-I dimensions). */
export const RadarChart = ({
  data,
  caption,
  max = 100,
  renderLabel,
}: {
  data: readonly Datum[];
  caption: string;
  max?: number;
  renderLabel?: (d: Datum) => ReactNode;
}) => {
  const size = 240;
  const center = size / 2;
  const radius = 84;
  const angle = (i: number) => (Math.PI * 2 * i) / data.length - Math.PI / 2;
  const at = (i: number, r: number) =>
    [center + Math.cos(angle(i)) * r, center + Math.sin(angle(i)) * r] as const;
  const ring = (f: number) => data.map((_, i) => at(i, radius * f).join(',')).join(' ');
  const shape = data
    .map((d, i) => at(i, (radius * Math.min(Math.max(d.value, 0), max)) / max).join(','))
    .join(' ');
  return (
    <figure className={styles.figure}>
      <svg className={styles.svg} viewBox={`0 0 ${size} ${size}`} aria-hidden="true">
        {[0.25, 0.5, 0.75, 1].map((f) => (
          <polygon key={f} className={styles.grid} points={ring(f)} />
        ))}
        {data.map((d, i) => {
          const [x, y] = at(i, radius);
          return <line key={d.key} className={styles.axis} x1={center} y1={center} x2={x} y2={y} />;
        })}
        <polygon className={styles.radarShape} points={shape} />
        {data.map((d, i) => {
          const [x, y] = at(i, radius + 18);
          return (
            <text key={d.key} className={styles.radarLabel} x={x} y={y + 4} textAnchor="middle">
              {renderLabel ? renderLabel(d) : d.label}
            </text>
          );
        })}
      </svg>
      <DataTable caption={caption} data={data} />
    </figure>
  );
};
