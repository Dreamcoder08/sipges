import type { ModuleRecord } from '@mascli/contracts';
import { useId, useState } from 'react';
import { Button } from '../../../shared/ui/Button.tsx';
import { actorGroups, actorName, INFLUENCE_BANDS, positionTone } from './actor-map.ts';
import styles from './Insights.module.css';

const point = (angle: number, radius: number) => ({
  x: 360 + Math.cos(angle) * radius,
  y: 335 + Math.sin(angle) * radius,
});
const short = (value: string, limit = 23) =>
  value.length > limit ? value.slice(0, limit - 1) + '…' : value;
const tones = [
  ['favor', 'Favorable'],
  ['expectante', 'Expectante'],
  ['neutral', 'Neutral'],
  ['contra', 'En contra'],
  ['unknown', 'Sin clasificar / mixto'],
] as const;

export const ActorMap = ({
  rows,
  onOpen,
}: {
  rows: readonly ModuleRecord[];
  onOpen: (id: string) => void;
}) => {
  const id = useId();
  const [selected, setSelected] = useState('');
  const groups = actorGroups(rows);
  const types = [...new Set(groups.filter((g) => g.band !== null).map((g) => g.type))];
  const visible = groups.find((g) => g.key === selected)?.rows ?? rows;
  const unclassified = groups
    .filter((g) => g.band === null)
    .reduce((sum, g) => sum + g.rows.length, 0);
  return (
    <section className={styles.panel} aria-labelledby={id}>
      <div className={styles.heading}>
        <div>
          <p className={styles.eyebrow}>Relacionamiento del proyecto</p>
          <h4 id={id}>Mapa de actores</h4>
        </div>
        <span className={styles.count}>{rows.length} actores</span>
      </div>
      <p className={styles.explanation}>
        Sectores por tipo de actor y anillos por influencia registrada: mayor influencia cerca del
        centro. El color muestra la posición frente al proyecto.
      </p>
      {rows.length ? (
        <div className={styles.actorLayout}>
          <div>
            <svg
              className={styles.actorMap}
              viewBox="0 0 720 690"
              role="group"
              aria-label="Mapa de actores por tipo e influencia"
            >
              <title>Clasificación de los actores del proyecto activo</title>
              {[275, 230, 185, 140, 95].map((radius, n) => (
                <circle
                  key={radius}
                  cx={360}
                  cy={335}
                  r={radius}
                  fill={n % 2 ? '#f0f3fc' : '#e5ebf7'}
                  stroke="#c6d1e6"
                />
              ))}
              {types.map((type, index) => {
                const angle = -Math.PI / 2 + (index * Math.PI * 2) / types.length;
                const edge = point(angle - Math.PI / types.length, 290);
                const label = point(angle, 312);
                return (
                  <g key={type}>
                    <line
                      x1={360}
                      y1={335}
                      x2={edge.x}
                      y2={edge.y}
                      stroke="#9aaac4"
                      strokeDasharray="4 5"
                    />
                    <text
                      x={label.x}
                      y={label.y + (label.y > 580 ? 25 : 0)}
                      textAnchor={label.x > 580 ? 'end' : label.x < 140 ? 'start' : 'middle'}
                      className={styles.sectorLabel}
                    >
                      <title>{type}</title>
                      {short(type)}
                    </text>
                  </g>
                );
              })}
              {INFLUENCE_BANDS.map((band, index) => (
                <text
                  key={band}
                  x={
                    point(-Math.PI / 2 + Math.PI / Math.max(types.length, 1), 95 + index * 45).x + 4
                  }
                  y={point(-Math.PI / 2 + Math.PI / Math.max(types.length, 1), 95 + index * 45).y}
                  className={styles.ringLabel}
                >
                  {band}
                </text>
              ))}
              <circle cx={360} cy={335} r={43} fill="#173958" />
              <text x={360} y={332} textAnchor="middle" fill="white" className={styles.centerLabel}>
                Proyecto
              </text>
              <text x={360} y={349} textAnchor="middle" fill="white" className={styles.centerLabel}>
                activo
              </text>
              {groups
                .filter((g) => g.band !== null)
                .map((group) => {
                  const angle =
                    -Math.PI / 2 + (types.indexOf(group.type) * Math.PI * 2) / types.length;
                  const p = point(angle, 95 + (group.band ?? 0) * 45);
                  const positions = new Set(
                    group.rows.map((row) => positionTone(row.Posicion_Proyecto)),
                  );
                  const tone =
                    positions.size === 1
                      ? positionTone(group.rows[0]?.Posicion_Proyecto)
                      : 'unknown';
                  const select = () => setSelected(group.key);
                  return (
                    <g
                      key={group.key}
                      role="button"
                      tabIndex={0}
                      aria-label={`${group.type}, influencia ${INFLUENCE_BANDS[group.band ?? 0]}: ${group.rows.length} actor(es)`}
                      aria-pressed={selected === group.key}
                      className={styles.node}
                      onClick={select}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault();
                          select();
                        }
                      }}
                    >
                      <title>{group.rows.map(actorName).join('\n')}</title>
                      <circle
                        cx={p.x}
                        cy={p.y}
                        r={17}
                        className={`${styles.marker} ${styles[tone]}`}
                      />
                      <text
                        x={p.x}
                        y={p.y + 5}
                        textAnchor="middle"
                        fill="white"
                        className={styles.nodeCount}
                      >
                        {group.rows.length}
                      </text>
                      <text x={p.x} y={p.y + 33} textAnchor="middle" className={styles.nodeLabel}>
                        {group.rows.length === 1
                          ? short(actorName(group.rows[0] as ModuleRecord), 19)
                          : `${group.rows.length} actores`}
                      </text>
                    </g>
                  );
                })}
            </svg>
            <ul className={styles.legend} aria-label="Leyenda de posición">
              {tones.map(([tone, label]) => (
                <li key={tone}>
                  <i className={styles[tone]} aria-hidden="true" />
                  {label}
                </li>
              ))}
            </ul>
            <p className={styles.explanation}>
              {unclassified
                ? `${unclassified} actor(es) sin influencia clasificada permanecen disponibles en la lista. `
                : ''}
              Los anillos agrupan atributos guardados. Abra una ficha para consultar relaciones y
              evidencias.
            </p>
          </div>
          <div className={styles.actorAside}>
            <label htmlFor={`${id}-group`}>Grupo de actores</label>
            <select
              id={`${id}-group`}
              value={groups.some((g) => g.key === selected) ? selected : ''}
              onChange={(e) => setSelected(e.target.value)}
            >
              <option value="">Todos los actores</option>
              {groups.map((group) => (
                <option key={group.key} value={group.key}>
                  {group.type} ·{' '}
                  {group.band === null ? 'Sin influencia clasificada' : INFLUENCE_BANDS[group.band]}{' '}
                  · {group.rows.length}
                </option>
              ))}
            </select>
            <p className={styles.explanation}>{visible.length} actor(es) en la selección</p>
            <ul className={styles.actorList}>
              {visible.map((row) => (
                <li key={row._id}>
                  <strong>{actorName(row)}</strong>
                  <span>
                    {String(row.Tipo_Actor || 'Sin tipo registrado')} ·{' '}
                    {String(row.Influencia || 'Sin influencia registrada')}
                  </span>
                  <span
                    className={`${styles.position} ${styles[positionTone(row.Posicion_Proyecto)]}`}
                  >
                    {String(row.Posicion_Proyecto || 'Posición sin registrar')}
                  </span>
                  {row.Interes ? <small>Interés: {String(row.Interes)}</small> : null}
                  <Button
                    variant="secondary"
                    data-return={`insight-${row._id}`}
                    onClick={() => onOpen(row._id)}
                  >
                    Ficha de actor {row._id}
                  </Button>
                </li>
              ))}
            </ul>
          </div>
        </div>
      ) : (
        <p role="status">No hay actores registrados para dibujar con los filtros actuales.</p>
      )}
    </section>
  );
};
