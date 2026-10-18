import { InternalLink, objectHref } from '../../shared/lib/navigation.tsx';
import { DIMENSION_NAMES } from '../../shared/lib/text.ts';
import { DimensionBadge, LevelPill } from '../../shared/ui/Badges.tsx';
import { Button } from '../../shared/ui/Button.tsx';
import { EvidenceTag } from './EvidenceTag.tsx';
import { LAYER_SLUGS, type MapPoint } from './territorial-model.ts';
import styles from './TerritorialMap.module.css';

/** Contextual sheet of one record: what it says, how it is placed and what supports it. */
export const PointCard = ({ point, onClose }: { point: MapPoint; onClose: () => void }) => (
  <div className={styles.sheetBody}>
    <p className={styles.kicker}>
      {point.layer} · <EvidenceTag state={point.evidence} />
    </p>
    <h4 className={styles.sheetTitle}>{point.title}</h4>
    <dl className={styles.detail}>
      <dt>Fecha</dt>
      <dd>{point.date || 'Sin fecha'}</dd>
      <dt>Localidad</dt>
      <dd>{point.locality}</dd>
      <dt>Ubicación</dt>
      <dd>
        {point.precision === 'exacta'
          ? 'Coordenadas WGS84 del registro'
          : 'Aproximada al centro de la localidad'}
      </dd>
      <dt>Dimensión</dt>
      <dd>
        <DimensionBadge code={point.dimension} /> {DIMENSION_NAMES[point.dimension]}
      </dd>
      {point.actor ? (
        <>
          <dt>Actor</dt>
          <dd>{point.actor}</dd>
        </>
      ) : null}
      <dt>Prioridad</dt>
      <dd>
        <LevelPill level={point.level} />
      </dd>
      {point.status ? (
        <>
          <dt>Estado</dt>
          <dd>{point.status}</dd>
        </>
      ) : null}
      <dt>Verificación</dt>
      <dd>{point.verification || 'Sin grado de verificación'}</dd>
      <dt>Fuente</dt>
      <dd>{point.source || 'Sin referencia de fuente'}</dd>
      <dt>Información</dt>
      <dd>{point.evidenceBasis}</dd>
      <dt>Código</dt>
      <dd>{point.id}</dd>
    </dl>
    <div className={styles.sheetActions}>
      <InternalLink href={objectHref(LAYER_SLUGS[point.layer], point.id)}>
        Abrir registro (vista 360°)
      </InternalLink>
      <Button variant="ghost" onClick={onClose}>
        Cerrar ficha
      </Button>
    </div>
  </div>
);
