import { type KeyboardEvent, useMemo } from 'react';
import { type GraphEdge, type GraphNode, layoutGraph } from './layout.ts';
import styles from './ForceGraph.module.css';

const WIDTH = 720;
const HEIGHT = 460;
const TONES = ['t0', 't1', 't2', 't3', 't4', 't5', 't6', 't7'] as const;

const short = (text: string, max = 28) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

/**
 * Link-analysis graph (docs/adr/0011 §6). Dependency-free SVG; colours come from CSS classes
 * so the strict CSP needs no inline styles. Nodes are keyboard-focusable; the edge list is
 * repeated in a visually hidden table for screen readers.
 */
export const ForceGraph = ({
  nodes,
  edges,
  root,
  label,
  onSelect,
}: {
  nodes: readonly GraphNode[];
  edges: readonly GraphEdge[];
  root?: string;
  label: string;
  onSelect?: (id: string) => void;
}) => {
  const positions = useMemo(
    () => layoutGraph(nodes, edges, { width: WIDTH, height: HEIGHT, ...(root ? { root } : {}) }),
    [nodes, edges, root],
  );
  const groups = useMemo(() => [...new Set(nodes.map((n) => n.group))].sort(), [nodes]);
  const tone = (group: string) => styles[TONES[groups.indexOf(group) % TONES.length] ?? 't0'];
  const names = new Map(nodes.map((n) => [n.id, n.label]));
  const activate = (id: string) => (event: KeyboardEvent<SVGGElement>) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      onSelect?.(id);
    }
  };
  return (
    <figure className={styles.figure}>
      <svg
        className={styles.svg}
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        role="group"
        aria-label={label}
      >
        <defs>
          <marker
            id="graph-arrow"
            viewBox="0 0 10 10"
            refX="20"
            refY="5"
            markerWidth="6"
            markerHeight="6"
            orient="auto-start-reverse"
          >
            <path d="M 0 0 L 10 5 L 0 10 z" className={styles.arrow} />
          </marker>
        </defs>
        <g aria-hidden="true">
          {edges.map((edge) => {
            const a = positions.get(edge.source);
            const b = positions.get(edge.target);
            if (!a || !b) return null;
            return (
              <g key={`${edge.source}>${edge.label}>${edge.target}`}>
                <line
                  x1={a.x}
                  y1={a.y}
                  x2={b.x}
                  y2={b.y}
                  className={edge.dashed ? `${styles.edge} ${styles.dashed}` : styles.edge}
                  markerEnd="url(#graph-arrow)"
                />
                <text x={(a.x + b.x) / 2} y={(a.y + b.y) / 2 - 4} className={styles.edgeLabel}>
                  {short(edge.label, 22)}
                </text>
              </g>
            );
          })}
        </g>
        {nodes.map((node) => {
          const p = positions.get(node.id);
          if (!p) return null;
          return (
            <g
              key={node.id}
              className={styles.node}
              transform={`translate(${p.x} ${p.y})`}
              role={onSelect ? 'link' : undefined}
              tabIndex={onSelect ? 0 : undefined}
              aria-label={`${node.group}: ${node.label}`}
              onClick={() => onSelect?.(node.id)}
              onKeyDown={activate(node.id)}
            >
              <circle r={node.id === root ? 14 : 10} className={tone(node.group)} />
              <text y={node.id === root ? 28 : 24} className={styles.nodeLabel}>
                {short(node.label)}
              </text>
            </g>
          );
        })}
      </svg>
      <figcaption className={styles.legend}>
        {groups.map((group) => (
          <span key={group}>
            <svg width="12" height="12" aria-hidden="true">
              <circle cx="6" cy="6" r="5" className={tone(group)} />
            </svg>{' '}
            {group}
          </span>
        ))}
      </figcaption>
      <table className="visually-hidden">
        <caption>Relaciones del grafo</caption>
        <tbody>
          {edges.map((edge) => (
            <tr key={`${edge.source}>${edge.label}>${edge.target}`}>
              <td>{names.get(edge.source)}</td>
              <td>{edge.label}</td>
              <td>{names.get(edge.target)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </figure>
  );
};
