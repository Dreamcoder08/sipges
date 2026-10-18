import { useEffect, useId, useRef } from 'react';
import { monthLabel } from '../../shared/lib/text.ts';
import { DimensionBadge } from '../../shared/ui/Badges.tsx';
import { Button } from '../../shared/ui/Button.tsx';
import type { MonthCount } from '../../shared/ui/time/TimeHistogram.tsx';
import { TimeHistogram } from '../../shared/ui/time/TimeHistogram.tsx';
import { EvidenceTag } from './EvidenceTag.tsx';
import { type MapPoint, monthOf } from './territorial-model.ts';
import styles from './TerritorialMap.module.css';

/** Entries listed at once; the map still draws every visible record. */
export const LIST_LIMIT = 150;
/** Time each month stays on screen while the evolution plays. */
export const STEP_MS = 1100;

/**
 * Evolution panel synchronised with the map (ODD geospatial-timeline T5): the histogram sets
 * the period, playback walks it month by month (the map shows what was documented up to that
 * month, the month itself highlighted) and the list selects and frames records on the map. It
 * replays documented history; it never projects forward.
 */
export const TerritorialTimeline = ({
  series,
  points,
  from,
  to,
  cursor,
  playing,
  selectedId,
  onPeriod,
  onCursor,
  onPlaying,
  onSelect,
}: {
  series: readonly MonthCount[];
  points: readonly MapPoint[];
  from: string;
  to: string;
  cursor: string;
  playing: boolean;
  selectedId: string;
  onPeriod: (from: string, to: string) => void;
  onCursor: (month: string) => void;
  onPlaying: (playing: boolean) => void;
  onSelect: (point: MapPoint) => void;
}) => {
  const id = useId();
  const months = series.map((s) => s.month).filter((m) => (!from || m >= from) && (!to || m <= to));
  const index = cursor ? months.indexOf(cursor) : -1;
  const latest = useRef({ months, index, onCursor, onPlaying });
  useEffect(() => {
    latest.current = { months, index, onCursor, onPlaying };
  });
  useEffect(() => {
    if (!playing) return;
    const timer = setInterval(() => {
      const { months, index, onCursor, onPlaying } = latest.current;
      const next = months[index + 1];
      if (next) onCursor(next);
      else onPlaying(false);
    }, STEP_MS);
    return () => clearInterval(timer);
  }, [playing]);

  const list = useRef<HTMLOListElement>(null);
  useEffect(() => {
    if (!selectedId) return;
    const item = list.current?.querySelector<HTMLElement>(`[data-id="${CSS.escape(selectedId)}"]`);
    item?.scrollIntoView?.({ block: 'nearest' });
  }, [selectedId]);

  const sorted = [...points].sort((a, b) => b.date.localeCompare(a.date));
  const shown = sorted.slice(0, LIST_LIMIT);
  const play = () => {
    if (index < 0 || index >= months.length - 1) onCursor(months[0] ?? '');
    onPlaying(true);
  };
  return (
    <div className={styles.evolution}>
      {series.length > 1 ? (
        <>
          <TimeHistogram
            series={series}
            from={from}
            to={to}
            label="Registros georreferenciados por mes"
            onChange={onPeriod}
          />
          <div className={styles.playback}>
            {playing ? (
              <Button variant="secondary" onClick={() => onPlaying(false)}>
                Pausar
              </Button>
            ) : (
              <Button variant="secondary" onClick={play} disabled={months.length < 2}>
                Reproducir evolución
              </Button>
            )}
            <label htmlFor={`${id}-cursor`} className="visually-hidden">
              Mes mostrado
            </label>
            <input
              id={`${id}-cursor`}
              type="range"
              min={0}
              max={Math.max(0, months.length - 1)}
              step={1}
              value={Math.max(0, index)}
              aria-valuetext={cursor ? monthLabel(cursor) : 'Todo el periodo'}
              onChange={(event) => {
                onPlaying(false);
                onCursor(months[Number(event.target.value)] ?? '');
              }}
            />
            <span aria-live="polite" className={styles.cursorLabel}>
              {cursor ? `Hasta ${monthLabel(cursor)}` : 'Todo el periodo'}
            </span>
            {cursor ? (
              <Button
                variant="ghost"
                onClick={() => {
                  onPlaying(false);
                  onCursor('');
                }}
              >
                Ver todo
              </Button>
            ) : null}
          </div>
          <p className={styles.note}>
            La reproducción muestra lo documentado hasta cada mes; no proyecta ni extrapola. Pulse
            un mes del gráfico para acotar el periodo (Mayús amplía el rango).
          </p>
        </>
      ) : null}
      {shown.length ? (
        <ol ref={list} className={styles.timeline} aria-label="Registros del periodo">
          {shown.map((p) => (
            <li
              key={`${p.layer}-${p.id}`}
              data-id={p.id}
              data-selected={p.id === selectedId}
              data-current={Boolean(cursor) && monthOf(p) === cursor}
            >
              <span className={`${styles.dot} ${styles[p.dimension] ?? ''}`} aria-hidden="true" />
              <small>
                {p.date || 'Sin fecha'} · {p.locality} · {p.layer}
              </small>
              <button
                type="button"
                className={styles.linkButton}
                aria-pressed={p.id === selectedId}
                onClick={() => onSelect(p)}
              >
                <DimensionBadge code={p.dimension} /> {p.title}
              </button>
              <small>
                <EvidenceTag state={p.evidence} /> ·{' '}
                {p.source ? `Fuente ${p.source}` : 'Sin fuente'}
              </small>
            </li>
          ))}
        </ol>
      ) : (
        <p className={styles.note}>Sin registros georreferenciados para estos filtros.</p>
      )}
      {sorted.length > shown.length ? (
        <p className={styles.note}>
          Se listan los {LIST_LIMIT} más recientes de {sorted.length}; el mapa muestra todos. Acote
          el periodo para ver los anteriores.
        </p>
      ) : null}
    </div>
  );
};
