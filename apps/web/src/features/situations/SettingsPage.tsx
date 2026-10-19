import { ProjectSettings, type ProjectSettingsIn } from '@mascli/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useState } from 'react';
import { requestJson } from '../../shared/api/client.ts';
import type { FeatureContext } from '../../shared/api/feature-context.ts';
import { errorDetail } from '../../shared/api/feedback.ts';
import { projectSettingsQuery } from '../../shared/api/project-settings.ts';
import { formatDateTime, LEVELS } from '../../shared/lib/text.ts';
import { Alert } from '../../shared/ui/Alert.tsx';
import { LevelPill } from '../../shared/ui/Badges.tsx';
import { Button } from '../../shared/ui/Button.tsx';
import { Card } from '../../shared/ui/Card.tsx';
import { Field } from '../../shared/ui/Field.tsx';
import { QueryState } from '../../shared/ui/QueryState.tsx';
import styles from './Situations.module.css';

const FEATURES = [
  'Situaciones: registros relacionados por tema, actor o territorio en fechas cercanas.',
  'Peso del tiempo: lo reciente pesa más y se indica cuando un tema va en aumento.',
  'Alertas explicadas, con los registros que las originan y acciones sugeridas.',
  'Colores con su significado y buzón de quejas, denuncias, consultas y sugerencias.',
];

/** MASCLI 4.0 switch and colour meanings of the active project (docs/adr/0020). */
export const SettingsPage = ({ scope, role }: FeatureContext) => {
  const settings = useQuery(projectSettingsQuery(scope));
  // Kept here: the form remounts with the saved settings, which would drop the message.
  const [notice, setNotice] = useState('');
  return (
    <div className={styles.page}>
      <QueryState query={settings} label="la configuración de MASCLI 4.0">
        {(data) => (
          <SettingsForm
            key={data.updated_at ?? 'default'}
            scope={scope}
            data={data}
            admin={role === 'admin'}
            onSaved={setNotice}
          />
        )}
      </QueryState>
      {notice ? <Alert tone="success">{notice}</Alert> : null}
    </div>
  );
};

const SettingsForm = ({
  scope,
  data,
  admin,
  onSaved,
}: {
  scope: string;
  data: ProjectSettings;
  admin: boolean;
  onSaved: (notice: string) => void;
}) => {
  const cache = useQueryClient();
  const [meanings, setMeanings] = useState(data.level_meanings);
  const [texts, setTexts] = useState(
    Object.fromEntries(data.recommendations.map((r) => [r.id, r.text])),
  );
  const save = useMutation({
    mutationFn: (body: ProjectSettingsIn) =>
      requestJson('/system/v4/settings', ProjectSettings, {
        scope,
        method: 'PUT',
        body: { json: body },
      }),
    onMutate: () => onSaved(''),
    onSuccess: async (saved, body) => {
      onSaved(
        body.recommendations
          ? 'Acciones sugeridas guardadas.'
          : body.version4 === undefined
            ? 'Significados guardados.'
            : saved.version4
              ? 'MASCLI 4.0 activado en este proyecto.'
              : 'El proyecto volvió a MASCLI 3.0.',
      );
      await cache.invalidateQueries({ queryKey: ['project-settings', scope] });
    },
  });
  const submit = (event: FormEvent) => {
    event.preventDefault();
    save.mutate({ level_meanings: meanings });
  };
  return (
    <>
      <Card
        eyebrow="Versión del proyecto"
        title={data.version4 ? 'MASCLI 4.0 activado' : 'MASCLI 3.0 (4.0 desactivado)'}
      >
        <p>
          MASCLI 4.0 agrega estas funciones sin cambiar lo que ya funciona. Se activa por proyecto y
          puede desactivarse en cualquier momento sin perder datos.
        </p>
        <ul>
          {FEATURES.map((feature) => (
            <li key={feature}>{feature}</li>
          ))}
        </ul>
        {data.updated_at ? (
          <p className={styles.muted}>
            Último cambio: {data.updated_by} · {formatDateTime(new Date(data.updated_at))}
          </p>
        ) : null}
        {admin ? (
          <Button
            variant={data.version4 ? 'secondary' : 'primary'}
            disabled={save.isPending}
            onClick={() => save.mutate({ version4: !data.version4 })}
          >
            {data.version4 ? 'Volver a MASCLI 3.0' : 'Activar MASCLI 4.0'}
          </Button>
        ) : (
          <p className={styles.muted}>Solo un administrador puede cambiar la versión.</p>
        )}
      </Card>
      <Card eyebrow="Niveles de riesgo" title="Significado de cada color">
        <p>
          Significados preliminares, pendientes de revisión metodológica. Con MASCLI 4.0 activo se
          muestran junto al color, por ejemplo «Naranja – Requiere intervención preventiva».
        </p>
        <form onSubmit={submit} className={styles.form}>
          {LEVELS.map((level) => (
            <Field
              key={level}
              label={level}
              value={meanings[level]}
              maxLength={120}
              required
              readOnly={!admin}
              onChange={(event) => setMeanings({ ...meanings, [level]: event.target.value })}
            />
          ))}
          {admin ? (
            <Button type="submit" disabled={save.isPending}>
              Guardar significados
            </Button>
          ) : null}
        </form>
        {data.version4 ? (
          <ul className={styles.legend} aria-label="Vista previa de niveles">
            {LEVELS.map((level) => (
              <li key={level}>
                <LevelPill level={level} />
              </li>
            ))}
          </ul>
        ) : null}
      </Card>
      <Card eyebrow="Recomendaciones" title="Acciones sugeridas por condición">
        <p>
          Cada situación muestra las acciones cuya condición se cumple. Solo orientan: la decisión
          es siempre de la persona. «{'{actores}'}» se reemplaza por los actores de la situación.
        </p>
        <form
          className={styles.form}
          onSubmit={(event) => {
            event.preventDefault();
            save.mutate({ recommendations: texts });
          }}
        >
          {data.recommendations.map((r) => (
            <Field
              key={r.id}
              label={r.condition}
              value={texts[r.id] ?? ''}
              maxLength={300}
              required
              readOnly={!admin}
              onChange={(event) => setTexts({ ...texts, [r.id]: event.target.value })}
            />
          ))}
          {admin ? (
            <Button type="submit" disabled={save.isPending}>
              Guardar acciones sugeridas
            </Button>
          ) : null}
        </form>
      </Card>
      {save.isError ? <Alert tone="error">{errorDetail(save.error)}</Alert> : null}
    </>
  );
};
