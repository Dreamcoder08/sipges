import { ProjectSettings, type ProjectSettingsIn } from '@sipges/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, type ReactNode, useState } from 'react';
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
import { AppearanceSection } from './AppearanceSection.tsx';
import { ExternalAiCard } from './ExternalAiCard.tsx';
import { LocationCard } from './LocationCard.tsx';
import { MediaMonitorCard } from './MediaMonitorCard.tsx';
import { PhaseCard } from './PhaseCard.tsx';
import { type SettingsSection, settingsHref } from './sections.ts';
import { SettingsNav } from './SettingsNav.tsx';
import layout from './SettingsPage.module.css';
import styles from './Situations.module.css';

const FEATURES = [
  'Situaciones: registros relacionados por tema, actor o territorio en fechas cercanas.',
  'Peso del tiempo: lo reciente pesa más y se indica cuando un tema va en aumento.',
  'Alertas explicadas, con los registros que las originan y acciones sugeridas.',
  'Colores con su significado y buzón de quejas, denuncias, consultas y sugerencias.',
  'Fase del proyecto con pesos IRSA propios y monitoreo de medios regionales por RSS.',
];

type SettingsPageProps = FeatureContext & {
  /** The section in the URL (`?seccion=`); Apariencia when absent. */
  section?: SettingsSection | undefined;
  /** Client-side navigation; without it the page switches sections on its own. */
  onNavigate?: ((href: string) => void) | undefined;
  /** The device notification switch, supplied by the app (features stay isolated). */
  notifications?: ReactNode;
};

/**
 * Configuración as one settings screen with a section list, like Claude's settings
 * (docs/adr/0018, docs/adr/0020): Apariencia, Proyecto, Privacidad y datos, Notificaciones and
 * a link to Integraciones. One section shows at a time and each one has its own URL.
 */
export const SettingsPage = ({
  scope,
  role,
  section,
  onNavigate,
  notifications,
}: SettingsPageProps) => {
  const [local, setLocal] = useState<SettingsSection>(section ?? 'apariencia');
  const current = onNavigate ? (section ?? 'apariencia') : local;
  // Kept here: the form remounts with the saved settings, which would drop the message.
  const [notice, setNotice] = useState<{ section: SettingsSection; text: string } | null>(null);
  return (
    <div className={layout.layout}>
      <SettingsNav
        current={current}
        onNavigate={onNavigate}
        onSection={(next) => (onNavigate ? onNavigate(settingsHref(next)) : setLocal(next))}
      />
      <div className={layout.content}>
        {current === 'apariencia' ? <AppearanceSection /> : null}
        {current === 'proyecto' || current === 'privacidad' ? (
          <ProjectSettingsSection
            scope={scope}
            section={current}
            admin={role === 'admin'}
            onSaved={(text) => setNotice(text ? { section: current, text } : null)}
          />
        ) : null}
        {current === 'notificaciones' ? (
          <Card eyebrow="Dispositivo" title="Notificaciones">
            <p className={styles.muted}>
              Los avisos pendientes se revisan en la bandeja. Aquí elige si este dispositivo también
              los recibe.
            </p>
            {notifications}
          </Card>
        ) : null}
        {notice?.section === current ? <Alert tone="success">{notice.text}</Alert> : null}
      </div>
    </div>
  );
};

const ProjectSettingsSection = ({
  scope,
  section,
  admin,
  onSaved,
}: {
  scope: string;
  section: 'proyecto' | 'privacidad';
  admin: boolean;
  onSaved: (notice: string) => void;
}) => {
  const settings = useQuery(projectSettingsQuery(scope));
  return (
    <QueryState query={settings} label="la configuración de SIPGES">
      {(data) => (
        <SettingsForm
          key={data.updated_at ?? 'default'}
          scope={scope}
          section={section}
          data={data}
          admin={admin}
          onSaved={onSaved}
        />
      )}
    </QueryState>
  );
};

const SettingsForm = ({
  scope,
  section,
  data,
  admin,
  onSaved,
}: {
  scope: string;
  section: 'proyecto' | 'privacidad';
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
    onSuccess: async (_saved, body) => {
      onSaved(
        body.external_ai
          ? `Envío a IA externa ${body.external_ai.enabled ? 'activado' : 'desactivado'}.`
          : body.location !== undefined
            ? `Ubicación del proyecto ${body.location ? 'guardada' : 'quitada'}.`
            : body.phase !== undefined
              ? 'Fase del proyecto guardada.'
              : body.phase_weights
                ? 'Pesos de la fase guardados.'
                : body.recommendations
                  ? 'Acciones sugeridas guardadas.'
                  : 'Significados guardados.',
      );
      await cache.invalidateQueries({ queryKey: ['project-settings', scope] });
    },
  });
  const submit = (event: FormEvent) => {
    event.preventDefault();
    save.mutate({ level_meanings: meanings });
  };
  const error = save.isError ? <Alert tone="error">{errorDetail(save.error)}</Alert> : null;
  if (section === 'privacidad')
    return (
      <>
        <ExternalAiCard data={data} admin={admin} pending={save.isPending} save={save.mutate} />
        {error}
      </>
    );
  return (
    <>
      <Card eyebrow="Proyecto" title="SIPGES">
        <p>Este proyecto funciona con SIPGES. Estas son sus funciones:</p>
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
      </Card>
      <Card eyebrow="Niveles de riesgo" title="Significado de cada color">
        <p>
          Significados preliminares, pendientes de revisión metodológica. Se muestran junto al
          color, por ejemplo «Naranja – Requiere intervención preventiva».
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
        <ul className={styles.legend} aria-label="Vista previa de niveles">
          {LEVELS.map((level) => (
            <li key={level}>
              <LevelPill level={level} />
            </li>
          ))}
        </ul>
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
      <LocationCard data={data} admin={admin} pending={save.isPending} save={save.mutate} />
      <PhaseCard data={data} admin={admin} pending={save.isPending} save={save.mutate} />
      <MediaMonitorCard scope={scope} admin={admin} />
      {error}
    </>
  );
};
