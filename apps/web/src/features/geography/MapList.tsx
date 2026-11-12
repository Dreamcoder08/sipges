import { type CSSProperties, useEffect, useId, useRef } from 'react';
import { InternalLink } from '../../shared/lib/navigation.tsx';
import { LAYER_SLUGS, type Layer, type MapPoint, type Unplaced } from './territorial-model.ts';
import styles from './TerritorialMap.module.css';

/** The record open in the Registros sheet (`?ficha=<type>.<id>`), where it can be edited. */
export const recordSheetHref = ({ layer, id }: { layer: Layer; id: string }) => {
  const slug = LAYER_SLUGS[layer];
  return `/registros?tipo=${slug}&ficha=${encodeURIComponent(`${slug}.${id}`)}`;
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
                {point.layer} · {point.date || 'Sin fecha'} · {point.locality}
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
      <summary id={id}>{records.length} registro(s) sin ubicación</summary>
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
