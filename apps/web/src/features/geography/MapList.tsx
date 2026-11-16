import { type CSSProperties, useEffect, useId, useLayoutEffect, useRef } from 'react';
import { InternalLink } from '../../shared/lib/navigation.tsx';
import { LAYER_SLUGS, type Layer, type MapPoint, type Unplaced } from './territorial-model.ts';
import styles from './TerritorialMap.module.css';
import { count } from '../../shared/lib/plural.ts';
import { DateText } from '../../shared/ui/DateText.tsx';

/** The record open in the Registros sheet (`?ficha=<type>.<id>`), where it can be edited. */
export const recordSheetHref = ({ layer, id }: { layer: Layer; id: string }) => {
  const slug = LAYER_SLUGS[layer];
  return `/registros?tipo=${slug}&ficha=${encodeURIComponent(`${slug}.${id}`)}`;
};

/** Rows the list shows before it scrolls, when the screen is tall enough for them. */
const ROWS_IN_VIEW = 5;

/**
 * Ends the list's scroll box on a row boundary, so no row shows cut in half at its edge
 * (functional-10 T14: the fifth row at 360 px). The box holds the first five rows whole, fewer
 * only when they would pass 80% of the screen height; the rows past them scroll inside the list.
 * Rows wrap again when the width or the font changes, so their sizes are observed, not read once.
 */
const wholeRows = (box: HTMLOListElement | null) => {
  if (!box) return;
  const rows = [...box.children].slice(0, ROWS_IN_VIEW + 1) as HTMLElement[];
  const fit = () => {
    if (rows.length <= ROWS_IN_VIEW || !rows[0]?.offsetHeight) {
      box.style.maxHeight = '';
      return;
    }
    const limit = Math.max(window.innerHeight * 0.8, rows[0].offsetTop + rows[0].offsetHeight);
    let bottom = 0;
    for (const row of rows.slice(0, ROWS_IN_VIEW)) {
      const end = row.offsetTop + row.offsetHeight;
      if (end > limit) break;
      bottom = end;
    }
    box.style.maxHeight = `${bottom}px`;
  };
  fit();
  if (typeof ResizeObserver === 'undefined') return;
  const observer = new ResizeObserver(fit);
  for (const row of rows) observer.observe(row);
  window.addEventListener('resize', fit);
  return () => {
    observer.disconnect();
    window.removeEventListener('resize', fit);
  };
};

/**
 * The records on the map, each row with the number of its marker (closure-roadmap T31,
 * direction 03 inside Territorio). Picking a row selects its marker; a marker picked on the map
 * marks its row and scrolls the list, never the page, to it.
 */
export const MapList = ({
  items,
  selectedId,
  onSelect,
}: {
  items: readonly { point: MapPoint; n: number }[];
  selectedId: string;
  onSelect: (point: MapPoint) => void;
}) => {
  const list = useRef<HTMLOListElement>(null);
  // Rendered rows are what it measures, so it runs again whenever they change.
  useLayoutEffect(() => wholeRows(list.current), [items]);
  useEffect(() => {
    const box = list.current;
    const row = [...(box?.querySelectorAll<HTMLElement>('[data-point]') ?? [])].find(
      (element) => element.dataset['point'] === selectedId,
    );
    if (!box || !row) return;
    const above = row.offsetTop < box.scrollTop;
    const below = row.offsetTop + row.offsetHeight > box.scrollTop + box.clientHeight;
    if (above || below) box.scrollTop = row.offsetTop - box.clientHeight / 2;
  }, [selectedId]);
  if (!items.length)
    return <p className={styles.note}>Ningún registro con ubicación coincide con los filtros.</p>;
  return (
    <ol ref={list} className={styles.mapList} aria-label="Registros en el mapa">
      {items.map(({ point, n }) => (
        <li key={`${point.layer}-${point.id}`}>
          <button
            type="button"
            className={styles.listRow}
            data-point={point.id}
            aria-pressed={point.id === selectedId}
            onClick={() => onSelect(point)}
          >
            <span
              className={styles.pin}
              style={{ '--pin': `var(--dim-${point.dimension.toLowerCase()})` } as CSSProperties}
            >
              {n}
            </span>
            <span className={styles.rowText}>
              <span>{point.title}</span>
              <small>
                {point.layer} · <DateText value={point.date} fallback="Sin fecha" /> ·{' '}
                {point.locality}
              </small>
            </span>
          </button>
        </li>
      ))}
    </ol>
  );
};

/** Records the map cannot place, counted and each one a link to where it can be completed. */
export const UnplacedGroup = ({
  records,
  sechura,
}: {
  records: readonly Unplaced[];
  sechura: boolean;
}) => {
  const id = useId();
  if (!records.length) return null;
  return (
    <details className={styles.unplaced} aria-labelledby={id}>
      <summary id={id}>{count(records.length, 'registro', 'registros')} sin ubicación</summary>
      <p className={styles.note}>
        {sechura
          ? 'No aparecen en el mapa: no tienen coordenadas ni una localidad de Sechura en «Territorio». Ábralos en Registros y use «Editar» para completar su territorio.'
          : 'No aparecen en el mapa: no tienen coordenadas WGS84 (Latitud y Longitud), y el formulario de Registros aún no las edita. Ábralos en Registros para revisarlos.'}
      </p>
      <ul className={styles.unplacedList}>
        {records.map((record) => (
          <li key={`${record.layer}-${record.id}`}>
            <InternalLink href={recordSheetHref(record)} className={styles.listRow}>
              <span className={styles.rowText}>
                <span>{record.title}</span>
                <small>
                  {record.layer} · {record.id}
                </small>
              </span>
            </InternalLink>
          </li>
        ))}
      </ul>
    </details>
  );
};
