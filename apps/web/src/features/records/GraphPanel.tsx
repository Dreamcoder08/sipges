import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { objectHref, useInternalNavigate } from '../../shared/lib/navigation.tsx';
import { Button } from '../../shared/ui/Button.tsx';
import { ForceGraph } from '../../shared/ui/graph/ForceGraph.tsx';
import { QueryState } from '../../shared/ui/QueryState.tsx';
import { presentText } from './model.ts';
import { catalogQuery, graphQuery } from './ontology-api.ts';
import styles from './Records.module.css';

const nodeKey = (ref: { module: string; id: string }) => `${ref.module}/${ref.id}`;

/** Link analysis around one record, one or two hops away (docs/adr/0011 §6). */
export const GraphPanel = ({
  module,
  id,
  scope,
}: {
  module: string;
  id: string;
  scope: string;
}) => {
  const [depth, setDepth] = useState(1);
  const graph = useQuery(graphQuery(module, id, scope, depth));
  const catalog = useQuery(catalogQuery);
  const navigate = useInternalNavigate();
  const labels = new Map(catalog.data?.link_types.map((t) => [t.id, t.label]) ?? []);
  return (
    <section className={styles.evidence} aria-labelledby={`graph-${id}`}>
      <div className={styles.graphHeader}>
        <h4 id={`graph-${id}`}>Grafo de relaciones</h4>
        <div className={styles.actions} role="group" aria-label="Profundidad del grafo">
          {[1, 2].map((value) => (
            <Button
              key={value}
              variant={depth === value ? 'primary' : 'secondary'}
              aria-pressed={depth === value}
              onClick={() => setDepth(value)}
            >
              {value === 1 ? 'Vínculos directos' : 'Dos saltos'}
            </Button>
          ))}
        </div>
      </div>
      <QueryState query={graph} label="el grafo">
        {(data) =>
          data.edges.length === 0 ? (
            <p className={styles.muted}>Este registro aún no tiene relaciones.</p>
          ) : (
            <>
              <ForceGraph
                label={`Grafo de relaciones de ${id}`}
                root={nodeKey(data.root)}
                nodes={data.nodes.map((node) => ({
                  id: nodeKey(node),
                  label: presentText(node.title),
                  group: node.type_label,
                }))}
                edges={data.edges.map((edge) => ({
                  source: nodeKey(edge.source),
                  target: nodeKey(edge.target),
                  label: labels.get(edge.link_type) ?? edge.link_type,
                  dashed: edge.inferred,
                }))}
                onSelect={(key) => {
                  const node = data.nodes.find((n) => nodeKey(n) === key);
                  if (node && key !== nodeKey(data.root))
                    navigate(objectHref(node.module, node.id));
                }}
              />
              <p className={styles.muted}>
                {data.nodes.length} registros · {data.edges.length} relaciones. Las líneas
                discontinuas son vínculos inferidos de los campos.
                {data.truncated ? ' El grafo se recortó para mantenerlo legible.' : ''}
              </p>
            </>
          )
        }
      </QueryState>
    </section>
  );
};
