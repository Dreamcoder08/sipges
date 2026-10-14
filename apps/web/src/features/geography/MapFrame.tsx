import { useId, type ReactNode } from 'react';
import { Icon } from '../../shared/ui/Icon.tsx';
import type { IconName } from '../../shared/ui/icons.ts';
import type { useMapView } from './useMapView.ts';
import styles from './MapFrame.module.css';

type MapView = ReturnType<typeof useMapView>;
export type MapAction = { label: string; icon: IconName; onClick: () => void; disabled?: boolean };

/**
 * Holds a map with its gestures (drag, pinch, Ctrl + wheel, arrow keys) and floating controls:
 * zoom in, zoom out, back to the home view and any extra actions. `children(describedBy)`
 * renders the map, which links the gesture hint through that id.
 */
export const MapFrame = ({
  map,
  homeLabel,
  actions = [],
  children,
}: {
  map: MapView;
  homeLabel: string;
  actions?: readonly MapAction[];
  children: (describedBy: string) => ReactNode;
}) => {
  const hint = useId();
  const controls: MapAction[] = [
    {
      label: 'Acercar',
      icon: 'plus',
      onClick: () => map.zoomBy(2),
      disabled: map.zoom >= map.maxZoom,
    },
    { label: 'Alejar', icon: 'minus', onClick: () => map.zoomBy(0.5), disabled: map.zoom <= 1 },
    { label: homeLabel, icon: 'home', onClick: map.reset },
    ...actions,
  ];
  return (
    <div className={styles.wrap}>
      <div className={styles.frame} {...map.bind}>
        {children(hint)}
        <div className={styles.controls}>
          {controls.map((c) => (
            <button
              key={c.label}
              type="button"
              className={styles.control}
              aria-label={c.label}
              title={c.label}
              disabled={c.disabled}
              onClick={c.onClick}
            >
              <Icon name={c.icon} />
            </button>
          ))}
        </div>
      </div>
      <p id={hint} className={styles.hint}>
        Arrastre o use dos dedos para mover el mapa y pellizque para acercar. En computadora: Ctrl +
        rueda, o las flechas y + / − con el mapa seleccionado.
      </p>
    </div>
  );
};
