import type { ProjectSettings, ProjectSettingsIn } from '@sipges/contracts';
import { type FormEvent, useState } from 'react';
import { Button } from '../../shared/ui/Button.tsx';
import { Card } from '../../shared/ui/Card.tsx';
import { Field } from '../../shared/ui/Field.tsx';
import styles from './Situations.module.css';

const BOUNDS = [
  { label: 'Oeste (longitud)', min: -180, max: 180 },
  { label: 'Sur (latitud)', min: -90, max: 90 },
  { label: 'Este (longitud)', min: -180, max: 180 },
  { label: 'Norte (latitud)', min: -90, max: 90 },
] as const;

/**
 * Where the project is (T19): the place named on the maps and the area they open on when no
 * record carries a position. Without one the maps keep the Sechura province.
 */
export const LocationCard = ({
  data,
  admin,
  pending,
  save,
}: {
  data: ProjectSettings;
  admin: boolean;
  pending: boolean;
  save: (body: ProjectSettingsIn) => void;
}) => {
  const saved = data.location ?? null;
  const [place, setPlace] = useState(saved?.place ?? '');
  const [extent, setExtent] = useState<string[]>(
    saved ? saved.extent.map(String) : ['', '', '', ''],
  );
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const [west = 0, south = 0, east = 0, north = 0] = extent.map(Number);
    save({ location: { place, extent: [west, south, east, north] } });
  };
  return (
    <Card eyebrow="Territorio" title="Ubicación del proyecto">
      <p>
        Los mapas abren en esta zona cuando los registros no tienen coordenadas y usan este lugar en
        sus títulos. Los distritos y localidades de Sechura solo aparecen si la zona toca esa
        provincia.
      </p>
      <p className={styles.muted}>
        {saved
          ? `Guardada: ${saved.place}.`
          : 'Sin ubicación guardada: los mapas abren en la provincia de Sechura.'}{' '}
        Coordenadas WGS 84 en grados decimales; por ejemplo, Tambogrande: oeste −80.548, sur −5.057,
        este −80.218, norte −4.880.
      </p>
      <form onSubmit={submit} className={styles.form}>
        <Field
          label="Lugar"
          value={place}
          minLength={2}
          maxLength={80}
          required
          readOnly={!admin}
          placeholder="Tambogrande, Piura"
          onChange={(event) => setPlace(event.target.value)}
        />
        <div className={styles.coordinates}>
          {BOUNDS.map((bound, index) => (
            <Field
              key={bound.label}
              label={bound.label}
              type="number"
              inputMode="decimal"
              step="any"
              min={bound.min}
              max={bound.max}
              required
              readOnly={!admin}
              value={extent[index] ?? ''}
              onChange={(event) =>
                setExtent(extent.map((v, i) => (i === index ? event.target.value : v)))
              }
            />
          ))}
        </div>
        {admin ? (
          <div className={styles.actions}>
            <Button type="submit" disabled={pending}>
              Guardar ubicación
            </Button>
            {saved ? (
              <Button
                type="button"
                variant="secondary"
                disabled={pending}
                onClick={() => save({ location: null })}
              >
                Quitar ubicación
              </Button>
            ) : null}
          </div>
        ) : null}
      </form>
    </Card>
  );
};
