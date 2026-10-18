import type { ModuleRecord } from '@mascli/contracts';
import { useEffect, useId, useMemo, useRef, useState, type PointerEvent } from 'react';
import { Button } from '../../../shared/ui/Button.tsx';
import {
  CARD,
  INFLUENCE_BANDS,
  layoutActors,
  MAP,
  type PlacedActor,
  positionTone,
  RING_EDGES,
  ringEdge,
  RINGS,
  SECTORS,
  toPoint,
} from './actor-map.ts';
import styles from './Insights.module.css';
import map from './ActorMap.module.css';

const tones = [
  ['favor', 'Favorable'],
  ['expectante', 'Expectante'],
  ['neutral', 'Neutral'],
  ['contra', 'En contra'],
  ['unknown', 'Sin clasificar / otra'],
] as const;
const RING_FILLS = ['#f4a7af', '#cddcfb', '#90a5f0'] as const;
const MIN_ZOOM = 1;
const MAX_ZOOM = 6;

/** Splits a name into at most two lines that fit an actor card. */
const lines = (text: string, limit = 24) => {
  const words = text.split(/\s+/);
  const out: string[] = [''];
  for (const word of words) {
    const current = out[out.length - 1] ?? '';
    if (!current || (current + ' ' + word).length <= limit) {
      out[out.length - 1] = current ? `${current} ${word}` : word;
    } else if (out.length < 2) out.push(word);
    else {
      out[1] = `${out[1]} ${word}`;
      break;
    }
  }
  return out.map((line) => (line.length > limit ? line.slice(0, limit - 1) + '…' : line));
};

/** Where a line from the centre to a card enters the card's border. */
const cardEdge = (x: number, y: number, scale: number) => {
  const dx = x - MAP.cx;
  const dy = y - MAP.cy;
  const t = Math.min(
    dx ? (CARD.width * scale) / 2 / Math.abs(dx) : Infinity,
    dy ? (CARD.height * scale) / 2 / Math.abs(dy) : Infinity,
  );
  return { x: x - dx * Math.min(t, 1), y: y - dy * Math.min(t, 1) };
};

const relationText = (actor: PlacedActor) => {
  const strength =
    actor.relation.strength === 'fuerte'
      ? 'Relación fuerte'
      : actor.relation.strength === 'debil'
        ? 'Relación débil'
        : 'Tipo de relación sin registrar';
  const direction =
    actor.relation.direction === 'proyecto'
      ? 'del proyecto al actor'
      : actor.relation.direction === 'actor'
        ? 'del actor al proyecto'
        : actor.relation.direction === 'ambos'
          ? 'en ambos sentidos'
          : 'sentido sin registrar';
  return `${strength}, ${direction}`;
};

type View = { k: number; x: number; y: number };

export const ActorMap = ({
  rows,
  onOpen,
}: {
  rows: readonly ModuleRecord[];
  onOpen: (id: string) => void;
}) => {
  const id = useId();
  const [sector, setSector] = useState('');
  const [active, setActive] = useState<{
    id: string;
    pinned: boolean;
    left: string;
    top: string;
  } | null>(null);
  const { actors: placed, scale } = useMemo(() => layoutActors(rows), [rows]);
  const visible = placed.filter((a) => !sector || a.sector === sector);
  const svgRef = useRef<SVGSVGElement>(null);
  const layerRef = useRef<SVGGElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const view = useRef<View>({ k: 1, x: 0, y: 0 });
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const gesture = useRef({ moved: false, touch: false, distance: 0 });
  const [zoom, setZoom] = useState(1);

  /** Writes the pan and zoom straight to the layer, so dragging never re-renders React. */
  const apply = (next: View) => {
    const k = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, next.k));
    const x = Math.min(0, Math.max(MAP.width * (1 - k), next.x));
    const y = Math.min(0, Math.max(MAP.height * (1 - k), next.y));
    view.current = { k, x, y };
    layerRef.current?.setAttribute('transform', `translate(${x} ${y}) scale(${k})`);
    if (k !== zoom) setZoom(k);
    setActive(null);
  };
  /** Converts a screen point into map units. */
  const toMap = (clientX: number, clientY: number) => {
    const box = svgRef.current?.getBoundingClientRect();
    if (!box || !box.width) return { x: MAP.cx, y: MAP.cy };
    return {
      x: ((clientX - box.left) / box.width) * MAP.width,
      y: ((clientY - box.top) / box.height) * MAP.height,
    };
  };
  const zoomAt = (factor: number, at: { x: number; y: number } = { x: MAP.cx, y: MAP.cy }) => {
    const { k, x, y } = view.current;
    const next = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, k * factor));
    apply({ k: next, x: at.x - ((at.x - x) * next) / k, y: at.y - ((at.y - y) * next) / k });
  };

  const hasRows = rows.length > 0;
  // Phones scroll a canvas wider than the screen: start with the project centre in view.
  useEffect(() => {
    const stage = stageRef.current;
    if (stage && stage.scrollWidth > stage.clientWidth)
      stage.scrollLeft = (stage.scrollWidth - stage.clientWidth) / 2;
  }, [hasRows]);

  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    // Ctrl/⌘ + wheel and trackpad pinch zoom the map; a plain wheel keeps scrolling the page.
    const wheel = (event: WheelEvent) => {
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      zoomAt(Math.exp(-event.deltaY * 0.01), toMap(event.clientX, event.clientY));
    };
    svg.addEventListener('wheel', wheel, { passive: false });
    return () => svg.removeEventListener('wheel', wheel);
  });

  const down = (event: PointerEvent<SVGSVGElement>) => {
    pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    gesture.current.touch = event.pointerType === 'touch';
    if (pointers.current.size === 1) gesture.current.moved = false;
    if (pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()] as [
        { x: number; y: number },
        { x: number; y: number },
      ];
      gesture.current.distance = Math.hypot(a.x - b.x, a.y - b.y);
    }
  };
  const move = (event: PointerEvent<SVGSVGElement>) => {
    const last = pointers.current.get(event.pointerId);
    if (!last) return;
    const now = { x: event.clientX, y: event.clientY };
    pointers.current.set(event.pointerId, now);
    if (pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()] as [
        { x: number; y: number },
        { x: number; y: number },
      ];
      const distance = Math.hypot(a.x - b.x, a.y - b.y);
      if (gesture.current.distance)
        zoomAt(distance / gesture.current.distance, toMap((a.x + b.x) / 2, (a.y + b.y) / 2));
      gesture.current.distance = distance;
      gesture.current.moved = true;
      return;
    }
    if (Math.abs(now.x - last.x) + Math.abs(now.y - last.y) < 1 && !gesture.current.moved) return;
    const start = toMap(last.x, last.y);
    const end = toMap(now.x, now.y);
    if (!gesture.current.moved && Math.hypot(end.x - start.x, end.y - start.y) > 0.5) {
      gesture.current.moved = true;
      setActive(null);
    }
    if (!gesture.current.moved) return;
    if (!svgRef.current?.hasPointerCapture(event.pointerId))
      svgRef.current?.setPointerCapture?.(event.pointerId);
    const { k, x, y } = view.current;
    apply({ k, x: x + end.x - start.x, y: y + end.y - start.y });
  };
  const up = (event: PointerEvent<SVGSVGElement>) => {
    pointers.current.delete(event.pointerId);
    if (pointers.current.size < 2) gesture.current.distance = 0;
  };

  /** Opens the detail card under an actor, placed for the current pan and zoom. */
  const show = (actor: PlacedActor, pinned: boolean) => {
    const { k, x, y } = view.current;
    setActive({
      id: actor.row._id,
      pinned,
      left: `${((actor.x * k + x) / MAP.width) * 100}%`,
      top: `${((actor.y * k + y + (CARD.height / 2) * scale * k) / MAP.height) * 100}%`,
    });
  };
  const choose = (actor: PlacedActor) => {
    if (gesture.current.moved) return;
    // A tap on a phone shows the card first; a click or Enter opens the actor record.
    if (gesture.current.touch) show(actor, true);
    else onOpen(actor.row._id);
  };
  const shown = placed.find((a) => a.row._id === active?.id);
  const counts = SECTORS.map((s) => placed.filter((a) => a.sector === s).length);

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
        Cuadrantes por sector y anillos por influencia registrada: Control (influencia alta) al
        centro, Influencia (media-alta y media) e Interés (media-baja, baja o sin registrar) afuera.
        El color muestra la posición frente al proyecto y la línea, la relación registrada.
      </p>
      {rows.length ? (
        <>
          <div className={map.toolbar}>
            <div className={map.zoom} role="group" aria-label="Acercamiento del mapa">
              <Button variant="secondary" onClick={() => zoomAt(1.4)} aria-label="Acercar mapa">
                +
              </Button>
              <Button
                variant="secondary"
                onClick={() => zoomAt(1 / 1.4)}
                disabled={zoom <= MIN_ZOOM}
                aria-label="Alejar mapa"
              >
                −
              </Button>
              <Button
                variant="secondary"
                onClick={() => apply({ k: 1, x: 0, y: 0 })}
                disabled={zoom <= MIN_ZOOM}
              >
                Ver todo
              </Button>
            </div>
            <p className={map.hint}>
              Arrastre para mover; use los botones, Ctrl + rueda o dos dedos para acercar.
            </p>
          </div>
          <div
            ref={stageRef}
            className={map.stage}
            onPointerLeave={() => setActive((a) => (a?.pinned ? a : null))}
          >
            <div className={map.canvas}>
              <svg
                ref={svgRef}
                className={`${map.svg} ${zoom > MIN_ZOOM ? map.zoomed : ''}`}
                viewBox={`0 0 ${MAP.width} ${MAP.height}`}
                role="group"
                aria-label="Mapa de actores por sector e influencia"
                onPointerDown={down}
                onPointerMove={move}
                onPointerUp={up}
                onPointerCancel={up}
                onClick={(event) => {
                  if (event.target === svgRef.current && !gesture.current.moved) setActive(null);
                }}
              >
                <title>Actores del proyecto activo por sector, influencia y posición</title>
                <defs>
                  <marker
                    id={`${id}-arrow`}
                    viewBox="0 0 10 10"
                    refX="9"
                    refY="5"
                    markerWidth="7"
                    markerHeight="7"
                    orient="auto-start-reverse"
                  >
                    <path d="M0 0 L10 5 L0 10 z" fill="#1d2b3f" />
                  </marker>
                </defs>
                <g ref={layerRef}>
                  {[3, 2, 1].map((edge) => (
                    <ellipse
                      key={edge}
                      cx={MAP.cx}
                      cy={MAP.cy}
                      rx={ringEdge(edge) * MAP.stretch}
                      ry={ringEdge(edge)}
                      fill={RING_FILLS[edge - 1]}
                    />
                  ))}
                  <line
                    x1={MAP.cx}
                    x2={MAP.cx}
                    y1={MAP.cy - RING_EDGES[3] - 14}
                    y2={MAP.cy + RING_EDGES[3] + 14}
                    className={map.axis}
                  />
                  <line
                    x1={MAP.cx - RING_EDGES[3] * MAP.stretch - 14}
                    x2={MAP.cx + RING_EDGES[3] * MAP.stretch + 14}
                    y1={MAP.cy}
                    y2={MAP.cy}
                    className={map.axis}
                    strokeDasharray="3 5"
                  />
                  {RINGS.map((ring, index) => (
                    <text
                      key={ring}
                      x={MAP.cx + 8}
                      y={MAP.cy - ringEdge(index + 1) + 16}
                      className={map.ringLabel}
                    >
                      {ring.toUpperCase()}
                    </text>
                  ))}
                  {SECTORS.map((name, index) => {
                    const left = name === 'Gobierno' || name === 'Academia';
                    const top = name === 'Gobierno' || name === 'Privado';
                    return (
                      <text
                        key={name}
                        x={left ? 18 : MAP.width - 18}
                        y={top ? 30 : MAP.height - 16}
                        textAnchor={left ? 'start' : 'end'}
                        className={map.sectorLabel}
                      >
                        {name.toUpperCase()} · {counts[index]}
                      </text>
                    );
                  })}
                  {visible.map((actor) => {
                    const edge = cardEdge(actor.x, actor.y, scale);
                    const angle = Math.atan2(
                      (actor.y - MAP.cy) / RING_EDGES[0],
                      (actor.x - MAP.cx) / (RING_EDGES[0] * MAP.stretch),
                    );
                    const start = toPoint(angle, RING_EDGES[0] + 2);
                    const { strength, direction } = actor.relation;
                    const marker = `url(#${id}-arrow)`;
                    return (
                      <line
                        key={`line-${actor.row._id}`}
                        x1={start.x}
                        y1={start.y}
                        x2={edge.x}
                        y2={edge.y}
                        className={
                          strength === 'fuerte'
                            ? map.strong
                            : strength === 'debil'
                              ? map.weak
                              : map.unrecorded
                        }
                        markerEnd={
                          direction === 'proyecto' || direction === 'ambos' ? marker : undefined
                        }
                        markerStart={
                          direction === 'actor' || direction === 'ambos' ? marker : undefined
                        }
                      />
                    );
                  })}
                  <ellipse
                    cx={MAP.cx}
                    cy={MAP.cy}
                    rx={RING_EDGES[0] * MAP.stretch}
                    ry={RING_EDGES[0]}
                    fill="white"
                    stroke="#173958"
                    strokeWidth={2}
                  />
                  <text x={MAP.cx} y={MAP.cy - 4} textAnchor="middle" className={map.centerLabel}>
                    Proyecto
                  </text>
                  <text x={MAP.cx} y={MAP.cy + 14} textAnchor="middle" className={map.centerLabel}>
                    activo
                  </text>
                  {visible.map((actor) => {
                    const [first, second] = lines(actor.name);
                    const label = `${actor.name}. ${actor.sector}${actor.sectorInferred ? ' (inferido)' : ''}, anillo ${RINGS[actor.ring]}, posición ${String(actor.row.Posicion_Proyecto || 'sin registrar')}. Abrir ficha`;
                    return (
                      <g
                        key={actor.row._id}
                        role="button"
                        tabIndex={0}
                        aria-label={label}
                        className={`${map.actor} ${map[actor.tone]} ${active?.id === actor.row._id ? map.current : ''}`}
                        transform={`translate(${actor.x - (CARD.width * scale) / 2} ${actor.y - (CARD.height * scale) / 2}) scale(${scale})`}
                        onPointerEnter={(e) => {
                          if (e.pointerType !== 'touch' && !active?.pinned) show(actor, false);
                        }}
                        onFocus={() => show(actor, false)}
                        onBlur={() => setActive((a) => (a?.pinned ? a : null))}
                        onClick={() => choose(actor)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' || e.key === ' ') {
                            e.preventDefault();
                            onOpen(actor.row._id);
                          }
                        }}
                      >
                        <rect width={CARD.width} height={CARD.height} rx={5} />
                        <text x={CARD.width / 2} y={second ? 14 : 21} textAnchor="middle">
                          {first}
                        </text>
                        {second ? (
                          <text x={CARD.width / 2} y={27} textAnchor="middle">
                            {second}
                          </text>
                        ) : null}
                      </g>
                    );
                  })}
                </g>
              </svg>
              {shown && active ? (
                <div
                  className={`${map.tooltip} ${active?.pinned ? map.pinned : ''}`}
                  style={{ left: active.left, top: active.top }}
                  role={active?.pinned ? 'dialog' : 'tooltip'}
                  aria-label={active?.pinned ? shown.name : undefined}
                >
                  <strong>{shown.name}</strong>
                  <span>
                    {String(shown.row.Tipo_Actor || 'Tipo sin registrar')} · {shown.sector}
                    {shown.sectorInferred ? ' (sector inferido)' : ''}
                  </span>
                  {shown.row.Territorio ? <span>{String(shown.row.Territorio)}</span> : null}
                  <span>
                    Influencia:{' '}
                    {shown.band === null ? 'sin registrar' : INFLUENCE_BANDS[shown.band]} · anillo{' '}
                    {RINGS[shown.ring]}
                  </span>
                  <span className={`${styles.position} ${styles[shown.tone]}`}>
                    {String(shown.row.Posicion_Proyecto || 'Posición sin registrar')}
                  </span>
                  <span>{relationText(shown)}</span>
                  {active?.pinned ? (
                    <div className={map.tooltipActions}>
                      <Button onClick={() => onOpen(shown.row._id)}>Abrir ficha</Button>
                      <Button variant="ghost" onClick={() => setActive(null)}>
                        Cerrar
                      </Button>
                    </div>
                  ) : (
                    <small>Clic para abrir la ficha</small>
                  )}
                </div>
              ) : null}
            </div>
          </div>
          <div className={map.legends}>
            <div>
              <h5>Posición frente al proyecto</h5>
              <ul className={styles.legend} aria-label="Leyenda de posición">
                {tones.map(([tone, label]) => (
                  <li key={tone}>
                    <i className={styles[tone]} aria-hidden="true" />
                    {label}
                  </li>
                ))}
              </ul>
            </div>
            <div>
              <h5>Tipo de relación</h5>
              <ul className={map.lineLegend}>
                <li>
                  <svg viewBox="0 0 40 10" aria-hidden="true">
                    <line x1="0" y1="5" x2="40" y2="5" className={map.strong} />
                  </svg>
                  Fuerte
                </li>
                <li>
                  <svg viewBox="0 0 40 10" aria-hidden="true">
                    <line x1="0" y1="5" x2="40" y2="5" className={map.weak} />
                  </svg>
                  Débil
                </li>
                <li>
                  <svg viewBox="0 0 40 10" aria-hidden="true">
                    <line x1="0" y1="5" x2="40" y2="5" className={map.unrecorded} />
                  </svg>
                  Sin registrar
                </li>
              </ul>
            </div>
            <div>
              <h5>Sentido de la relación</h5>
              <ul className={map.lineLegend}>
                {(
                  [
                    ['Del proyecto al actor', false, true],
                    ['Del actor al proyecto', true, false],
                    ['De ambos', true, true],
                  ] as const
                ).map(([label, start, end]) => (
                  <li key={label}>
                    <svg viewBox="0 0 40 10" aria-hidden="true">
                      <line
                        x1="3"
                        y1="5"
                        x2="37"
                        y2="5"
                        className={map.strong}
                        markerStart={start ? `url(#${id}-arrow)` : undefined}
                        markerEnd={end ? `url(#${id}-arrow)` : undefined}
                      />
                    </svg>
                    {label}
                  </li>
                ))}
              </ul>
            </div>
          </div>
          <p className={styles.explanation}>
            Cuando un actor no tiene sector registrado se infiere del tipo de actor o del nombre; si
            no se reconoce, queda en Sociedad civil. El tipo y el sentido de la relación se
            registran en la ficha del actor.
          </p>
          <div className={map.listHeader}>
            <label htmlFor={`${id}-sector`}>Sector</label>
            <select id={`${id}-sector`} value={sector} onChange={(e) => setSector(e.target.value)}>
              <option value="">Todos los sectores · {placed.length}</option>
              {SECTORS.map((name, index) => (
                <option key={name} value={name}>
                  {name} · {counts[index]}
                </option>
              ))}
            </select>
            <p className={styles.explanation}>{visible.length} actor(es) en el mapa</p>
          </div>
          <ul className={`${styles.actorList} ${map.list}`}>
            {visible.map((actor) => (
              <li key={actor.row._id}>
                <strong>{actor.name}</strong>
                <span>
                  {actor.sector} · {String(actor.row.Tipo_Actor || 'Sin tipo registrado')} ·{' '}
                  {String(actor.row.Influencia || 'Sin influencia registrada')}
                </span>
                <span
                  className={`${styles.position} ${styles[positionTone(actor.row.Posicion_Proyecto)]}`}
                >
                  {String(actor.row.Posicion_Proyecto || 'Posición sin registrar')}
                </span>
                <Button
                  variant="secondary"
                  data-return={`insight-${actor.row._id}`}
                  onClick={() => onOpen(actor.row._id)}
                >
                  Ficha de actor {actor.row._id}
                </Button>
              </li>
            ))}
          </ul>
        </>
      ) : (
        <p role="status">No hay actores registrados para dibujar con los filtros actuales.</p>
      )}
    </section>
  );
};
