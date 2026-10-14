import { type Result, err, ok } from '@mascli/kernel';
import {
  INFERENCE_RULES,
  LINK_TYPES,
  type LinkProblem,
  OBJECT_TYPES,
  type ObjectType,
  checkLink,
  linkTypeById,
  objectTypeForModule,
  objectTypeForSlug,
  titleOf,
} from '../domain/catalog.ts';
import type { Clock, NodeRef, NodeRow, OntologyStore, ResolvedRule } from './ports.ts';

/** Graph bounds (docs/adr/0011 §6). */
export const MAX_GRAPH_DEPTH = 2;
export const MAX_GRAPH_NODES = 150;

const MAX_ID = 200;

export type ObjectSummary = {
  readonly slug: string;
  readonly id: string;
  readonly typeLabel: string;
  readonly title: string;
  readonly date: string | null;
  readonly fields: Readonly<Record<string, string>>;
};

export type Edge = {
  /** Explicit link id; null for inferred links. */
  readonly id: number | null;
  readonly linkType: string;
  readonly source: { readonly slug: string; readonly id: string };
  readonly target: { readonly slug: string; readonly id: string };
  readonly inferred: boolean;
  /** Payload field an inferred link was read from. */
  readonly via: string | null;
  readonly note: string;
  readonly createdBy: string | null;
  readonly createdAt: Date | null;
};

export type Neighbour = {
  readonly edge: Edge;
  readonly direction: 'out' | 'in';
  readonly label: string;
  readonly other: ObjectSummary;
};

const RULES: readonly ResolvedRule[] = INFERENCE_RULES.flatMap((rule, index) => {
  const holder = objectTypeForSlug(rule.holder);
  const target = objectTypeForSlug(rule.target);
  return holder && target
    ? [
        {
          index,
          holderModule: holder.module,
          field: rule.field,
          targetModule: target.module,
          match: rule.match,
          targetTitleField: target.titleField,
        },
      ]
    : [];
});

const key = (ref: { module: string; id: string }) => `${ref.module}\u0000${ref.id}`;

const text = (value: unknown) =>
  typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
    ? String(value).trim()
    : '';

export const summarize = (objectType: ObjectType, row: NodeRow): ObjectSummary => ({
  slug: objectType.slug,
  id: row.id,
  typeLabel: objectType.label,
  title: titleOf(objectType, row.id, row.payload),
  date: objectType.dateField ? text(row.payload[objectType.dateField]) || null : null,
  fields: Object.fromEntries(
    objectType.summaryFields
      .map((field) => [field, text(row.payload[field])] as const)
      .filter(([, value]) => value !== ''),
  ),
});

const isUsableId = (id: string) => id.length > 0 && id.length <= MAX_ID && !id.includes('\u0000');

export const createOntologyService = (deps: { store: OntologyStore; clock: Clock }) => {
  const { store, clock } = deps;

  /** Explicit and inferred edges touching `refs`, explicit first, without duplicates. */
  const edgesTouching = async (tenantId: string, refs: readonly NodeRef[]): Promise<Edge[]> => {
    const [links, matches] = await Promise.all([
      store.links(tenantId, refs),
      store.inferred(tenantId, refs, RULES),
    ]);
    const edges: Edge[] = [];
    const seen = new Set<string>();
    const add = (edge: Edge, source: NodeRef, target: NodeRef) => {
      const id = `${edge.linkType}\u0001${key(source)}\u0001${key(target)}`;
      if (seen.has(id)) return;
      seen.add(id);
      edges.push(edge);
    };
    for (const link of links) {
      const source = objectTypeForModule(link.source.module);
      const target = objectTypeForModule(link.target.module);
      if (!source || !target) continue;
      add(
        {
          id: link.id,
          linkType: link.linkType,
          source: { slug: source.slug, id: link.source.id },
          target: { slug: target.slug, id: link.target.id },
          inferred: false,
          via: null,
          note: link.note,
          createdBy: link.createdBy,
          createdAt: link.createdAt,
        },
        link.source,
        link.target,
      );
    }
    for (const match of matches) {
      const rule = INFERENCE_RULES[match.index];
      if (!rule) continue;
      const [from, to] = rule.holderIsSource
        ? [match.holder, match.target]
        : [match.target, match.holder];
      const source = objectTypeForModule(from.module);
      const target = objectTypeForModule(to.module);
      if (!source || !target) continue;
      add(
        {
          id: null,
          linkType: rule.linkType,
          source: { slug: source.slug, id: from.id },
          target: { slug: target.slug, id: to.id },
          inferred: true,
          via: rule.field,
          note: '',
          createdBy: null,
          createdAt: null,
        },
        from,
        to,
      );
    }
    return edges;
  };

  const summaries = async (tenantId: string, refs: readonly NodeRef[]) => {
    const rows = refs.length ? await store.nodes(tenantId, refs) : [];
    const result = new Map<string, ObjectSummary>();
    for (const row of rows) {
      const objectType = objectTypeForModule(row.module);
      if (objectType) result.set(`${objectType.slug}\u0000${row.id}`, summarize(objectType, row));
    }
    return result;
  };

  const refFor = (slug: string, id: string): NodeRef | null => {
    const objectType = objectTypeForSlug(slug);
    return objectType && isUsableId(id) ? { module: objectType.module, id } : null;
  };

  return {
    catalog: () => ({ objectTypes: OBJECT_TYPES, linkTypes: LINK_TYPES }),

    /** The record and every record linked to it, or null when it does not exist. */
    async neighbours(tenantId: string, slug: string, id: string) {
      const ref = refFor(slug, id);
      if (!ref) return null;
      const self = (await summaries(tenantId, [ref])).get(`${slug}\u0000${id}`);
      if (!self) return null;
      const edges = await edgesTouching(tenantId, [ref]);
      const others = edges.map((edge) =>
        edge.source.slug === slug && edge.source.id === id ? edge.target : edge.source,
      );
      const found = await summaries(
        tenantId,
        others.flatMap((other) => refFor(other.slug, other.id) ?? []),
      );
      const neighbours: Neighbour[] = edges.flatMap((edge, index) => {
        const other = others[index];
        const summary = other && found.get(`${other.slug}\u0000${other.id}`);
        const linkType = linkTypeById(edge.linkType);
        if (!summary || !linkType) return [];
        const direction = edge.source.slug === slug && edge.source.id === id ? 'out' : 'in';
        return [
          {
            edge,
            direction,
            label: direction === 'out' ? linkType.label : linkType.inverseLabel,
            other: summary,
          },
        ];
      });
      return { record: self, neighbours };
    },

    /** Breadth-first neighbourhood of one record, bounded by depth and node count. */
    async graph(tenantId: string, slug: string, id: string, depth: number) {
      const root = refFor(slug, id);
      if (!root) return null;
      const hops = Math.max(1, Math.min(MAX_GRAPH_DEPTH, Math.trunc(depth) || 1));
      const visited = new Map<string, NodeRef>([[key(root), root]]);
      const edges = new Map<string, Edge>();
      let frontier: NodeRef[] = [root];
      let truncated = false;
      for (let hop = 0; hop < hops && frontier.length > 0; hop++) {
        const next: NodeRef[] = [];
        for (const edge of await edgesTouching(tenantId, frontier)) {
          const ends = [edge.source, edge.target].map((end) => refFor(end.slug, end.id));
          if (ends.some((end) => end === null)) continue;
          const missing = (ends as NodeRef[]).filter((end) => !visited.has(key(end)));
          if (visited.size + missing.length > MAX_GRAPH_NODES) {
            truncated = true;
            continue;
          }
          for (const end of missing) {
            visited.set(key(end), end);
            next.push(end);
          }
          edges.set(
            `${edge.linkType}\u0001${edge.source.slug}\u0000${edge.source.id}\u0001${edge.target.slug}\u0000${edge.target.id}`,
            edge,
          );
        }
        frontier = next;
      }
      const nodes = await summaries(tenantId, [...visited.values()]);
      if (!nodes.has(`${slug}\u0000${id}`)) return null;
      const present = [...edges.values()].filter(
        (edge) =>
          nodes.has(`${edge.source.slug}\u0000${edge.source.id}`) &&
          nodes.has(`${edge.target.slug}\u0000${edge.target.id}`),
      );
      return { root: { slug, id }, nodes: [...nodes.values()], edges: present, truncated };
    },

    async link(
      tenantId: string,
      input: {
        linkType: string;
        source: { slug: string; id: string };
        target: { slug: string; id: string };
        note: string;
      },
      actor: string,
    ): Promise<Result<number, LinkProblem | 'missing' | 'duplicate'>> {
      const problem = checkLink(input.linkType, input.source, input.target);
      if (problem) return err(problem);
      const source = refFor(input.source.slug, input.source.id);
      const target = refFor(input.target.slug, input.target.id);
      const linkType = linkTypeById(input.linkType);
      if (!source || !target || !linkType) return err('missing');
      const created = await store.createLink(
        tenantId,
        {
          linkType: linkType.id,
          source,
          target,
          note: input.note.trim(),
          symmetric: linkType.symmetric,
          createdBy: actor,
          auditDetail: `${source.module} ${source.id} ${linkType.label} ${target.module} ${target.id}`,
        },
        clock.now(),
      );
      return created.ok ? ok(created.id) : err(created.error);
    },

    unlink: (tenantId: string, id: number) => store.deleteLink(tenantId, id, clock.now()),
  };
};

export type OntologyService = ReturnType<typeof createOntologyService>;
