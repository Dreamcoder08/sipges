import type { PhaseWeights, ProjectSettings, ProjectSettingsIn } from '@sipges/contracts';
import { useState } from 'react';
import { Button } from '../../shared/ui/Button.tsx';
import { Card } from '../../shared/ui/Card.tsx';
import { Field } from '../../shared/ui/Field.tsx';
import styles from './Situations.module.css';

/** IRSA dimensions, in the order the IRSA screen shows them. */
const DIMENSIONS = [
  ['G', 'Gobernanza y representación'],
  ['A', 'Actores e influencia'],
  ['D', 'Demandas y compromisos'],
  ['N', 'Narrativas y señales digitales'],
  ['E', 'Ambiental-territorial'],
  ['I', 'Institucional y trazabilidad'],
] as const;

const total = (weights: Record<string, number>) =>
  Math.round(Object.values(weights).reduce((a, b) => a + b, 0) * 1000) / 1000;

/** Project phase and its IRSA weights (docs/adr/0021 §4). */
export const PhaseCard = ({
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
  const [editing, setEditing] = useState(data.phase ?? 'exploracion');
  const phase = data.phases.find((p) => p.id === editing);
  const [weights, setWeights] = useState<Record<string, number>>(
    phase?.weights ?? phase?.suggestion ?? {},
  );
  const pick = (id: typeof editing) => {
    setEditing(id);
    const next = data.phases.find((p) => p.id === id);
    setWeights(next?.weights ?? next?.suggestion ?? {});
  };
  const sum = total(weights);
  const current = data.phases.find((p) => p.id === data.phase);
  return (
    <Card eyebrow="Fase del proyecto" title={current ? current.label : 'Fase sin definir'}>
      <p>
        Cada fase puede tener sus propios pesos IRSA. Si la fase actual tiene pesos guardados, el
        IRSA los usa y lo indica; si no, usa los pesos generales. Las sugerencias son preliminares
        hasta su validación metodológica (AHP/Delphi).
      </p>
      {current ? (
        <p className={styles.muted}>
          {current.weights
            ? `El IRSA usa los pesos de la fase ${current.label}.`
            : `La fase ${current.label} no tiene pesos guardados: el IRSA usa los pesos generales.`}
        </p>
      ) : null}
      {admin ? (
        <div className={styles.actions}>
          {data.phases.map((p) => (
            <Button
              key={p.id}
              size="sm"
              variant={p.id === data.phase ? 'primary' : 'secondary'}
              aria-pressed={p.id === data.phase}
              disabled={pending}
              onClick={() => save({ phase: p.id })}
            >
              {p.label}
            </Button>
          ))}
        </div>
      ) : null}
      <form
        className={styles.form}
        onSubmit={(event) => {
          event.preventDefault();
          save({ phase_weights: { [editing]: weights as PhaseWeights } });
        }}
      >
        <label className={styles.select}>
          Pesos de la fase
          <select value={editing} onChange={(event) => pick(event.target.value as typeof editing)}>
            {data.phases.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
                {p.weights ? ' (pesos guardados)' : ''}
              </option>
            ))}
          </select>
        </label>
        <div className={styles.weights}>
          {DIMENSIONS.map(([key, label]) => (
            <Field
              key={key}
              label={`${key} · ${label}`}
              type="number"
              min={0}
              max={1}
              step={0.01}
              required
              readOnly={!admin}
              value={weights[key] ?? 0}
              onChange={(event) => setWeights({ ...weights, [key]: Number(event.target.value) })}
            />
          ))}
        </div>
        <p className={Math.abs(sum - 1) > 0.02 ? styles.error : styles.muted}>
          Suma: {sum} (debe ser 1)
        </p>
        {admin ? (
          <div className={styles.actions}>
            <Button type="submit" disabled={pending || Math.abs(sum - 1) > 0.02}>
              Guardar pesos de la fase
            </Button>
            <Button
              variant="secondary"
              disabled={pending}
              onClick={() => setWeights({ ...(phase?.suggestion ?? {}) })}
            >
              Usar sugerencia preliminar
            </Button>
            {phase?.weights ? (
              <Button
                variant="ghost"
                disabled={pending}
                onClick={() => save({ phase_weights: { [editing]: null } })}
              >
                Volver a los pesos generales
              </Button>
            ) : null}
          </div>
        ) : null}
      </form>
    </Card>
  );
};
