import type { ProjectSettings, ProjectSettingsIn } from '@sipges/contracts';
import { Card } from '../../shared/ui/Card.tsx';
import styles from './Situations.module.css';

/** «Envío a IA externa» (docs/adr/0030): off by default; only an administrator changes it. */
export const ExternalAiCard = ({
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
  const enabled = data.external_ai?.enabled ?? false;
  return (
    <Card eyebrow="Privacidad" title="IA externa">
      <p>
        Envío a IA externa — los datos salen siempre seudonimizados; nunca se envían nombres reales
        ni datos sensibles. Requiere revisión legal (Ley 29733).
      </p>
      <label>
        <input
          type="checkbox"
          checked={enabled}
          disabled={!admin || pending}
          onChange={(event) => save({ external_ai: { enabled: event.target.checked } })}
        />{' '}
        Envío a IA externa
      </label>
      <p className={styles.muted}>
        {enabled
          ? 'Activado: el servidor MCP, el resumen asistido y los embeddings externos pueden recibir datos seudonimizados. Cada envío queda en Auditoría.'
          : 'Desactivado: ningún dato del proyecto sale hacia IA externa.'}
      </p>
    </Card>
  );
};
