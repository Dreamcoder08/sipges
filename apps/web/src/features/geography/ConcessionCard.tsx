import type { GeographyResult } from '@mascli/contracts';
import { InternalLink, objectHref } from '../../shared/lib/navigation.tsx';
import { foldText } from '../../shared/lib/text.ts';
import { Button } from '../../shared/ui/Button.tsx';
import { type Concession, legendOf } from './concessions.ts';
import { GEOCATMIN_VIEWER } from './MiningCadastreLayer.tsx';
import type { MapPoint } from './territorial-model.ts';
import { EVIDENCE_LABELS } from './evidence.ts';
import styles from './TerritorialMap.module.css';

/** Record modules with a 360° view; other related modules are listed without a link. */
const LINKABLE = new Set(['eventos', 'demandas', 'actores', 'narrativas']);

const hectares = new Intl.NumberFormat('es-PE', { maximumFractionDigits: 2 });

export type Relation = {
  readonly status: 'pending' | 'error' | 'unsupported' | 'ready';
  readonly data?: GeographyResult;
  readonly retry: () => void;
};

/**
 * Contextual sheet of one official concession: what INGEMMET publishes about it and which
 * MASCLI records are tied to it by explicit coordinates or a documented code reference. Names
 * and approximate localities never relate a record to a concession.
 */
export const ConcessionCard = ({
  concession,
  source,
  relation,
  points,
  relatedOnly,
  onRelatedOnly,
  onFocusPoint,
  onFrame,
  onClose,
}: {
  concession: Concession;
  source: string;
  relation: Relation;
  points: readonly MapPoint[];
  relatedOnly: boolean;
  onRelatedOnly: (value: boolean) => void;
  onFocusPoint: (point: MapPoint) => void;
  onFrame: () => void;
  onClose: () => void;
}) => {
  const related = relation.data?.related ?? [];
  const byKey = new Map(points.map((p) => [`${foldText(p.layer)}:${p.id}`, p]));
  const history = related
    .map((r) => byKey.get(`${foldText(r.module)}:${r.id}`))
    .filter((p): p is MapPoint => Boolean(p))
    .sort((a, b) => a.date.localeCompare(b.date));
  return (
    <div className={styles.sheetBody}>
      <p className={styles.kicker}>Concesión minera · INGEMMET</p>
      <h4 className={styles.sheetTitle}>{concession.name}</h4>
      <dl className={styles.detail}>
        <dt>Código</dt>
        <dd>{concession.code}</dd>
        <dt>Titular</dt>
        <dd>{concession.holder || 'No publicado'}</dd>
        <dt>Situación</dt>
        <dd>
          <span
            className={styles.swatch}
            style={{ borderColor: `rgb(${legendOf(concession.legend).color.join(' ')})` }}
            aria-hidden="true"
          />{' '}
          {legendOf(concession.legend).label}
          {concession.status ? ` · ${concession.status}` : ''}
        </dd>
        {concession.hectares !== null ? (
          <>
            <dt>Superficie</dt>
            <dd>{hectares.format(concession.hectares)} ha</dd>
          </>
        ) : null}
        {concession.formulatedAt ? (
          <>
            <dt>Formulación</dt>
            <dd>{concession.formulatedAt}</dd>
          </>
        ) : null}
        {concession.place ? (
          <>
            <dt>Ubicación</dt>
            <dd>{concession.place}</dd>
          </>
        ) : null}
        <dt>Fuente</dt>
        <dd>
          <a href={`${source}?f=pjson`} target="_blank" rel="noreferrer">
            Catastro minero GEOCATMIN
          </a>
          {concession.updatedAt ? ` · actualizado ${concession.updatedAt}` : ''} ·{' '}
          <a href={GEOCATMIN_VIEWER} target="_blank" rel="noreferrer">
            visor oficial
          </a>
        </dd>
      </dl>
      <div className={styles.sheetActions}>
        <Button variant="secondary" onClick={onFrame}>
          Encuadrar concesión
        </Button>
        <Button variant="ghost" onClick={onClose}>
          Cerrar ficha
        </Button>
      </div>

      <h5 className={styles.subhead}>Registros MASCLI vinculados</h5>
      {relation.status === 'pending' ? <p role="status">Relacionando registros…</p> : null}
      {relation.status === 'unsupported' ? (
        <p className={styles.note}>
          La geometría oficial supera el límite de vértices de la consulta; no se simplifica para no
          vincular registros fuera del límite real.
        </p>
      ) : null}
      {relation.status === 'error' ? (
        <p role="alert">
          No se pudo consultar la relación con INGEMMET.{' '}
          <Button variant="ghost" onClick={relation.retry}>
            Reintentar
          </Button>
        </p>
      ) : null}
      {relation.data ? (
        <>
          {related.length ? (
            <ul className={styles.relatedList}>
              {related.map((r) => {
                const slug = foldText(r.module);
                const point = byKey.get(`${slug}:${r.id}`);
                const name = `${r.module} · ${point?.title ?? r.id}`;
                return (
                  <li key={`${r.module}:${r.id}`}>
                    {LINKABLE.has(slug) ? (
                      <InternalLink href={objectHref(slug, r.id)}>{name}</InternalLink>
                    ) : (
                      <span>{name}</span>
                    )}
                    <small>
                      {r.relationship === 'geometry'
                        ? 'Dentro del polígono oficial'
                        : 'Referencia documentada al código'}{' '}
                      · {r.evidence}
                      {point ? ` · ${EVIDENCE_LABELS[point.evidence]}` : ''}
                    </small>
                  </li>
                );
              })}
            </ul>
          ) : (
            <p className={styles.note}>
              Ningún registro tiene coordenadas dentro de esta concesión ni una referencia
              documentada a su código.
            </p>
          )}
          {relation.data.unlocated.length ? (
            <p className={styles.note}>
              {relation.data.unlocated.length} registro(s) sin coordenadas WGS84 no se pueden
              vincular geométricamente; la localidad escrita no basta.
            </p>
          ) : null}
          {history.length ? (
            <>
              <h5 className={styles.subhead}>Evolución en la concesión</h5>
              <ol className={styles.history}>
                {history.map((p) => (
                  <li key={`${p.layer}-${p.id}`}>
                    <button
                      type="button"
                      className={styles.linkButton}
                      onClick={() => onFocusPoint(p)}
                    >
                      {p.date || 'Sin fecha'} · {p.title}
                    </button>
                  </li>
                ))}
              </ol>
              <label className={styles.inlineCheck}>
                <input
                  type="checkbox"
                  checked={relatedOnly}
                  onChange={(event) => onRelatedOnly(event.target.checked)}
                />
                Mostrar solo estos registros en el mapa y la evolución temporal
              </label>
            </>
          ) : null}
        </>
      ) : null}
      <p className={styles.note}>
        Las áreas de influencia y la proximidad entre registros y concesiones se calcularán con
        PostGIS en una fase posterior.
      </p>
    </div>
  );
};
