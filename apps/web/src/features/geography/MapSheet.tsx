import { type PointerEvent, type ReactNode, useRef, useState } from 'react';
import { Icon } from '../../shared/ui/Icon.tsx';
import styles from './TerritorialMap.module.css';

/** Distance a swipe must travel on the handle to change state, in CSS pixels. */
export const SWIPE = 40;

/**
 * Phone sheet for the territorial map (ODD geospatial-timeline S6): it sits at the bottom edge
 * without covering the map, peeks with the title and expands with a swipe up or a tap on the
 * handle; a swipe down folds it, and down again closes it. It is not modal: the map stays
 * usable behind it, and the close button returns to a clean map.
 */
export const MapSheet = ({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
}) => {
  const [open, setOpen] = useState(true);
  const [offset, setOffset] = useState(0);
  const start = useRef<number | null>(null);
  const down = (event: PointerEvent<HTMLButtonElement>) => {
    start.current = event.clientY;
    event.currentTarget.setPointerCapture?.(event.pointerId);
  };
  const move = (event: PointerEvent<HTMLButtonElement>) => {
    if (start.current === null) return;
    setOffset(Math.max(-120, Math.min(160, event.clientY - start.current)));
  };
  const up = (event: PointerEvent<HTMLButtonElement>) => {
    if (start.current === null) return;
    const dy = event.clientY - start.current;
    start.current = null;
    setOffset(0);
    if (dy < -SWIPE) setOpen(true);
    else if (dy > SWIPE) {
      if (open) setOpen(false);
      else onClose();
    } else setOpen((value) => !value);
  };
  return (
    <section
      className={styles.mapSheet}
      data-open={open}
      aria-label={title}
      style={offset ? { transform: `translateY(${offset}px)` } : undefined}
    >
      <div className={styles.mapSheetBar}>
        <button
          type="button"
          className={styles.handle}
          aria-expanded={open}
          aria-label={open ? `Contraer ${title}` : `Expandir ${title}`}
          onPointerDown={down}
          onPointerMove={move}
          onPointerUp={up}
          onPointerCancel={() => {
            start.current = null;
            setOffset(0);
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault();
              setOpen((value) => !value);
            }
          }}
        >
          <span aria-hidden="true" />
        </button>
        <button
          type="button"
          className={styles.sheetClose}
          aria-label="Cerrar ficha"
          onClick={onClose}
        >
          <Icon name="close" />
        </button>
      </div>
      <div className={styles.mapSheetContent}>{children}</div>
    </section>
  );
};
