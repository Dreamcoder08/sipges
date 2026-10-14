import { useId } from 'react';
import { BASEMAPS, type Basemap } from './TileLayer.tsx';
import styles from './MapFrame.module.css';

const OPTIONS: [Basemap, string][] = [
  ['satelite', BASEMAPS.satelite.label],
  ['calles', BASEMAPS.calles.label],
  ['ninguno', 'Sin mapa base'],
];

/** Choice of raster basemap under a map: satellite imagery, streets or none. */
export const BasemapPicker = ({
  value,
  onChange,
}: {
  value: Basemap;
  onChange: (value: Basemap) => void;
}) => {
  const name = useId();
  return (
    <fieldset className={styles.basemaps}>
      <legend>Mapa base</legend>
      {OPTIONS.map(([option, label]) => (
        <label key={option}>
          <input
            type="radio"
            name={name}
            value={option}
            checked={value === option}
            onChange={() => onChange(option)}
          />
          {label}
        </label>
      ))}
    </fieldset>
  );
};

/** Linked credit of the basemap in use, as its licence asks. */
export const BasemapCredit = ({ basemap }: { basemap: Basemap }) => {
  if (basemap === 'ninguno') return null;
  const { text, href } = BASEMAPS[basemap].attribution;
  return (
    <>
      Mapa base{' '}
      <a href={href} target="_blank" rel="noreferrer">
        {text}
      </a>
      .
    </>
  );
};
