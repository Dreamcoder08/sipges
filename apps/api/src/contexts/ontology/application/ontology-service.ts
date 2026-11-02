import { type Result, err, ok } from '@sipges/kernel';
import { log } from '../../../platform/observability/logger.ts';
import {
  type EgressGuard,
  type EgressSession,
  EXTERNAL_AI_DISABLED,
  exemptPayload,
} from '../../privacy/application/index.ts';
import {
  INFERENCE_RULES,
  LINK_TYPES,
  isMarking,
  type LinkProblem,
  OBJECT_TYPES,
  type ObjectType,
  checkLink,
  linkTypeById,
  objectTypeForModule,
  objectTypeForSlug,
  titleOf,
} from '../domain/catalog.ts';
import { findMention, suggestedLink } from '../domain/mentions.ts';
import { foldText, matchExcerpt, searchTerms, toPrefixQuery } from '../domain/search.ts';
import { MIN_SIMILARITY, cosine, embeddingText, fuseRankings } from '../domain/semantic.ts';
import type {
  Clock,
  Embedder,
  EmbeddingIndex,
  NodeRef,
  NodeRow,
  OntologyStore,
  ResolvedRule,
} from './ports.ts';

/** Graph bounds (docs/adr/0011 §6). */
export const MAX_GRAPH_DEPTH = 2;
export const MAX_GRAPH_NODES = 150;
/** Neighbourhood bounds (ODD territorial-operations): records on the map or in a concession. */
export const MAX_NEIGHBOURHOOD_SEEDS = 100;
export const MAX_NEIGHBOURHOOD_NODES = 400;

const MAX_ID = 200;
export const MAX_SEARCH_RESULTS = 50;
export const MAX_TIMELINE_RESULTS = 500;

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
/** Accepts yyyy, yyyy-mm or yyyy-mm-dd and expands it to the first or last day it covers. */
export const dayBound = (value: string, end: boolean): string | null => {
  const trimmed = value.trim();
  if (!trimmed) return end ? '9999-12-31' : '0000-01-01';
  if (/^\d{4}$/.test(trimmed)) return `${trimmed}-${end ? '12-31' : '01-01'}`;
  if (/^\d{4}-(0[1-9]|1[0-2])$/.test(trimmed)) return `${trimmed}-${end ? '31' : '01'}`;
  return ISO_DAY.test(trimmed) ? trimmed : null;
};

export type SearchHit = ObjectSummary & {
  readonly match: { readonly field: string; readonly excerpt: string } | null;
  /** Found (also) by meaning through stored embeddings. */
  readonly semantic: boolean;
};

/** Records embedded per search before ranking, so a new project indexes itself gradually. */
export const EMBED_BATCH = 16;
/** Embeddings compared per search; projects hold far fewer records than this. */
const MAX_VECTORS = 5000;

export type ObjectSummary = {
  readonly slug: string;
  readonly id: string;
  readonly typeLabel: string;
  readonly title: string;
  readonly date: string | null;
  readonly marking: string;
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
  readonly evidence?: ObjectSummary | null;
  readonly evidenceStatus?: 'available' | 'unavailable' | 'undocumented';
};

/** A record that names another in its text, with no link between them yet. */
export type Mention = {
  readonly other: ObjectSummary;
  /** Which record's text holds the mention. */
  readonly holder: 'self' | 'other';
  readonly field: string;
  readonly excerpt: string;
  readonly linkType: string;
  readonly source: { readonly slug: string; readonly id: string };
  readonly target: { readonly slug: string; readonly id: string };
};

/** Candidates scanned per call and mentions returned (docs/adr/0014 §8). */
export const MAX_MENTION_CANDIDATES = 2000;
export const MAX_MENTIONS = 12;

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

export const summarize = (
  objectType: ObjectType,
  row: NodeRow,
  extraFields: readonly string[] = [],
): ObjectSummary => ({
  slug: objectType.slug,
  id: row.id,
  typeLabel: objectType.label,
  title: titleOf(objectType, row.id, row.payload),
  date: objectType.dateField ? text(row.payload[objectType.dateField]) || null : null,
  marking: row.marking,
  fields: Object.fromEntries(
    [...new Set([...objectType.summaryFields, ...extraFields])]
      .map((field) => [field, text(row.payload[field])] as const)
      .filter(([, value]) => value !== ''),
  ),
});

const isUsableId = (id: string) => id.length > 0 && id.length <= MAX_ID && !id.includes('\u0000');

export const createOntologyService = (deps: {
  store: OntologyStore;
  clock: Clock;
  /** `egress` clears every text bound for an embedder that is not on this machine (ADR 0030). */
  semantic?: { index: EmbeddingIndex; embedder: Embedder; egress: EgressGuard };
}) => {
  const { store, clock } = deps;

  /** The egress session for one embeddings call; null for a local model, which is not egress. */
  const egressFor = async (
    semantic: { embedder: Embedder; egress: EgressGuard },
    tenantId: string,
    purpose: string,
  ): Promise<EgressSession | null> => {
    if (semantic.embedder.egress === 'local') return null;
    const opened = await semantic.egress.open({ tenantId, channel: 'embeddings', purpose });
    if (!opened.ok) throw new Error(EXTERNAL_AI_DISABLED);
    return opened.session;
  };

  const refreshEmbeddings = async (tenantId: string, limit: number) => {
    const semantic = deps.semantic;
    if (!semantic) return 0;
    const stale = (await semantic.index.stale(tenantId, semantic.embedder.model, limit)).flatMap(
      (record) => {
        const objectType = objectTypeForModule(record.module);
        return objectType ? [{ record, objectType }] : [];
      },
    );
    if (!stale.length) return 0;
    const session = await egressFor(semantic, tenantId, 'index');
    const sanitised = session?.records(
      stale.map(({ record, objectType }) => ({
        module: objectType.slug,
        id: record.id,
        title: titleOf(objectType, record.id, record.payload),
        marking: record.marking,
        fields: record.payload,
      })),
    );
    // A record the guard withholds is not embedded; it stays stale until it may be.
    const ready = stale.flatMap((item, i) => {
      const clean = sanitised?.[i];
      if (clean?.withheld) return [];
      const { record, objectType } = item;
      return [
        {
          record,
          text: embeddingText(
            objectType.label,
            clean ? (clean.title ?? clean.id) : titleOf(objectType, record.id, record.payload),
            clean ? clean.fields : record.payload,
          ),
        },
      ];
    });
    const texts = ready.map((item) => item.text);
    const cleared = session
      ? await session.releaseMany(texts)
      : texts.map((text) => exemptPayload(text, 'loopback'));
    const rows = [];
    for (const [i, { record }] of ready.entries()) {
      rows.push({
        module: record.module,
        id: record.id,
        hash: record.hash,
        vector: await semantic.embedder.embed(cleared[i] as (typeof cleared)[number]),
      });
    }
    if (rows.length)
      await semantic.index.save(tenantId, rows, semantic.embedder.model, clock.now());
    return rows.length;
  };

  /** Records closest in meaning to `raw`, best first; empty when the embedder is down. */
  const semanticRefsFor = async (
    tenantId: string,
    raw: string,
    modules: readonly string[],
    limit: number,
  ): Promise<NodeRef[]> => {
    const semantic = deps.semantic;
    if (!semantic) return [];
    try {
      await refreshEmbeddings(tenantId, EMBED_BATCH);
      const session = await egressFor(semantic, tenantId, 'search');
      const query = await semantic.embedder.embed(
        session
          ? await session.release(session.text(raw.trim()))
          : exemptPayload(raw.trim(), 'loopback'),
      );
      const vectors = await semantic.index.vectors(
        tenantId,
        modules,
        semantic.embedder.model,
        MAX_VECTORS,
      );
      return vectors
        .map((v) => ({ ref: { module: v.module, id: v.id }, score: cosine(query, v.vector) }))
        .filter((v) => v.score >= MIN_SIMILARITY)
        .sort((a, b) => b.score - a.score)
        .slice(0, limit)
        .map((v) => v.ref);
    } catch (error) {
      log('warn', 'semantic_search_unavailable', { error });
      return [];
    }
  };

  /** Explicit and inferred edges touching `refs`, explicit first, without duplicates. */
  const edgesTouching = async (tenantId: string, refs: readonly NodeRef[]): Promise<Edge[]> => {
    const [links, matches] = await Promise.all([
      store.links(tenantId, refs),
      store.inferred(tenantId, refs, RULES),
    ]);
    const evidenceType = objectTypeForSlug('fuentes');
    const evidenceRefs = links.flatMap((link) =>
      link.evidenceSourceId && evidenceType
        ? [{ module: evidenceType.module, id: link.evidenceSourceId }]
        : [],
    );
    const evidenceRows = evidenceRefs.length ? await store.nodes(tenantId, evidenceRefs) : [];
    const evidenceById = new Map(
      evidenceRows.map((row) => [row.id, evidenceType ? summarize(evidenceType, row) : null]),
    );
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
          evidence: link.evidenceSourceId
            ? (evidenceById.get(link.evidenceSourceId) ?? null)
            : null,
          evidenceStatus: link.evidenceSourceId
            ? evidenceById.has(link.evidenceSourceId)
              ? 'available'
              : 'unavailable'
            : 'undocumented',
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

  const summaries = async (
    tenantId: string,
    refs: readonly NodeRef[],
    extraFields: readonly string[] = [],
  ) => {
    const rows = refs.length ? await store.nodes(tenantId, refs) : [];
    const result = new Map<string, ObjectSummary>();
    for (const row of rows) {
      const objectType = objectTypeForModule(row.module);
      if (objectType)
        result.set(`${objectType.slug}\u0000${row.id}`, summarize(objectType, row, extraFields));
    }
    return result;
  };

  const refFor = (slug: string, id: string): NodeRef | null => {
    const objectType = objectTypeForSlug(slug);
    return objectType && isUsableId(id) ? { module: objectType.module, id } : null;
  };

  /**
   * Breadth-first exploration from `roots`, one entry of `hops` per hop: the link types that
   * hop follows, or null for every type. Bounded by `maxNodes`.
   */
  const explore = async (
    tenantId: string,
    roots: readonly NodeRef[],
    hops: readonly (readonly string[] | null)[],
    maxNodes: number,
    extraFields: readonly string[],
  ) => {
    const visited = new Map<string, NodeRef>(roots.map((root) => [key(root), root]));
    const edges = new Map<string, Edge>();
    let frontier: NodeRef[] = [...roots];
    let truncated = false;
    for (const follow of hops.slice(0, MAX_GRAPH_DEPTH)) {
      if (frontier.length === 0) break;
      const next: NodeRef[] = [];
      for (const edge of await edgesTouching(tenantId, frontier)) {
        if (follow && !follow.includes(edge.linkType)) continue;
        const ends = [edge.source, edge.target].map((end) => refFor(end.slug, end.id));
        if (ends.some((end) => end === null)) continue;
        const missing = (ends as NodeRef[]).filter((end) => !visited.has(key(end)));
        if (visited.size + missing.length > maxNodes) {
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
    const nodes = await summaries(tenantId, [...visited.values()], extraFields);
    const present = [...edges.values()].filter(
      (edge) =>
        nodes.has(`${edge.source.slug}\u0000${edge.source.id}`) &&
        nodes.has(`${edge.target.slug}\u0000${edge.target.id}`),
    );
    return { nodes: [...nodes.values()], edges: present, truncated };
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

    /**
     * Unlinked records whose title appears in this record's text, or that name this record in
     * theirs. Only object types with a specific link type to this one are scanned.
     */
    async mentions(tenantId: string, slug: string, id: string): Promise<Mention[] | null> {
      const ref = refFor(slug, id);
      const objectType = objectTypeForSlug(slug);
      if (!ref || !objectType) return null;
      const [row] = await store.nodes(tenantId, [ref]);
      if (!row) return null;
      const self = { slug, id };
      const linkable = OBJECT_TYPES.filter(
        (t) => suggestedLink(self, { slug: t.slug, id: '' }).linkType !== 'relacionado_con',
      );
      if (!linkable.length) return [];
      const connected = new Set(
        (await edgesTouching(tenantId, [ref])).map((edge) =>
          edge.source.slug === slug && edge.source.id === id
            ? `${edge.target.slug}\u0000${edge.target.id}`
            : `${edge.source.slug}\u0000${edge.source.id}`,
        ),
      );
      const textOf = (payload: Readonly<Record<string, unknown>>) =>
        Object.fromEntries(
          Object.entries(payload).flatMap(([field, value]) =>
            typeof value === 'string' && value.trim() ? [[field, value]] : [],
          ),
        );
      const selfText = textOf(row.payload);
      const selfTitle = titleOf(objectType, id, row.payload);
      const found: Mention[] = [];
      for (const candidate of await store.recent(
        tenantId,
        linkable.map((t) => t.module),
        MAX_MENTION_CANDIDATES,
      )) {
        const otherType = objectTypeForModule(candidate.module);
        if (!otherType || (otherType.slug === slug && candidate.id === id)) continue;
        if (connected.has(`${otherType.slug}\u0000${candidate.id}`)) continue;
        const other = summarize(otherType, candidate);
        const inSelf = other.title !== candidate.id ? findMention(selfText, other.title) : null;
        const inOther =
          inSelf ?? (selfTitle !== id ? findMention(textOf(candidate.payload), selfTitle) : null);
        if (!inOther) continue;
        const proposal = suggestedLink(self, { slug: otherType.slug, id: candidate.id });
        found.push({
          other,
          holder: inSelf ? 'self' : 'other',
          field: inOther.field,
          excerpt: inOther.excerpt,
          ...proposal,
        });
        if (found.length >= MAX_MENTIONS) break;
      }
      return found;
    },

    /** Breadth-first neighbourhood of one record, bounded by depth and node count. */
    async graph(tenantId: string, slug: string, id: string, depth: number) {
      const root = refFor(slug, id);
      if (!root) return null;
      const hops = Math.max(1, Math.min(MAX_GRAPH_DEPTH, Math.trunc(depth) || 1));
      const found = await explore(
        tenantId,
        [root],
        Array.from({ length: hops }, () => null),
        MAX_GRAPH_NODES,
        [],
      );
      if (!found.nodes.some((n) => n.slug === slug && n.id === id)) return null;
      return {
        root: { slug, id },
        nodes: found.nodes,
        edges: found.edges,
        truncated: found.truncated,
      };
    },

    /**
     * Joint neighbourhood of several records (ODD territorial-operations): the territorial
     * dossier of a concession or of the records on the map. `hops` lists the link types each
     * hop follows, so a path such as signal → alert → action does not wander through every
     * record of a linked actor. Seeds that do not exist or are not visible are left out;
     * `fields` adds payload fields to every node's summary.
     */
    async neighbourhood(
      tenantId: string,
      seeds: readonly { slug: string; id: string }[],
      hops: readonly (readonly string[])[],
      fields: readonly string[],
    ) {
      const roots = new Map<string, NodeRef>();
      for (const seed of seeds.slice(0, MAX_NEIGHBOURHOOD_SEEDS)) {
        const ref = refFor(seed.slug, seed.id);
        if (ref) roots.set(key(ref), ref);
      }
      const found = await explore(
        tenantId,
        [...roots.values()],
        hops,
        MAX_NEIGHBOURHOOD_NODES,
        fields,
      );
      const present = new Set(found.nodes.map((n) => `${n.slug}\u0000${n.id}`));
      return {
        seeds: seeds.filter((s) => present.has(`${s.slug}\u0000${s.id}`)),
        ...found,
      };
    },

    /**
     * Ranked full-text search across object types (docs/adr/0011 §5). With an embedder it is
     * hybrid (docs/adr/0014 §9): records close in meaning are fused with the lexical ranking;
     * any embedding failure leaves the lexical result untouched.
     */
    async search(
      tenantId: string,
      raw: string,
      slugs: readonly string[] | null,
      limit: number,
      /**
       * Only these fields may explain a hit: the excerpt comes from them, and a record found
       * only through other fields (or only by meaning) is left out, so a hit never reveals
       * what a field the caller may not see holds.
       */
      visibleField?: (slug: string, field: string) => boolean,
    ): Promise<SearchHit[]> {
      const terms = searchTerms(raw);
      const query = toPrefixQuery(terms);
      const types = (slugs?.length ? slugs : OBJECT_TYPES.map((t) => t.slug)).flatMap(
        (slug) => objectTypeForSlug(slug) ?? [],
      );
      const exactId = raw.trim();
      if (types.length === 0) return [];
      const bounded = Math.max(1, Math.min(MAX_SEARCH_RESULTS, Math.trunc(limit) || 1));
      const lexicalRows =
        query || isUsableId(exactId)
          ? await store.search(
              tenantId,
              query,
              exactId,
              types.map((t) => t.module),
              bounded,
            )
          : [];
      const semanticRefs =
        deps.semantic && terms.length > 0
          ? await semanticRefsFor(
              tenantId,
              raw,
              types.map((t) => t.module),
              bounded,
            )
          : [];
      const rows = new Map(lexicalRows.map((row) => [key(row), row]));
      const missing = semanticRefs.filter((ref) => !rows.has(key(ref)));
      for (const row of missing.length ? await store.nodes(tenantId, missing) : []) {
        rows.set(key(row), row);
      }
      const semanticKeys = new Set(semanticRefs.map(key));
      const ranked = fuseRankings([lexicalRows.map(key), semanticRefs.map(key)], bounded);
      return ranked.flatMap((k) => {
        const row = rows.get(k);
        const objectType = row && objectTypeForModule(row.module);
        if (!row || !objectType) return [];
        const payload = visibleField
          ? Object.fromEntries(
              Object.entries(row.payload).filter(([field]) => visibleField(objectType.slug, field)),
            )
          : row.payload;
        const match = matchExcerpt(payload, terms, [
          objectType.titleField,
          ...objectType.summaryFields,
        ]);
        // The store requires every term somewhere in the record; with hidden fields every term
        // must be in a visible one, or pairing a visible word with a probe reveals hidden text.
        if (visibleField) {
          const visible = foldText(
            Object.values(payload)
              .filter((v) => typeof v === 'string' || typeof v === 'number')
              .join(' '),
          );
          if (!match || !terms.every((term) => visible.includes(term))) return [];
        }
        return [{ ...summarize(objectType, row), match, semantic: semanticKeys.has(k) }];
      });
    },

    /** Embeds up to `limit` new or changed records; returns how many were embedded. */
    refreshEmbeddings: (tenantId: string, limit = EMBED_BATCH) =>
      refreshEmbeddings(tenantId, limit),

    /** Dated records across object types, newest first (docs/adr/0011 §7). */
    async timeline(
      tenantId: string,
      input: { from: string; to: string; slugs: readonly string[] | null; limit: number },
    ) {
      const from = dayBound(input.from, false);
      const to = dayBound(input.to, true);
      if (!from || !to) return null;
      const types = (input.slugs?.length ? input.slugs : OBJECT_TYPES.map((t) => t.slug)).flatMap(
        (slug) => {
          const objectType = objectTypeForSlug(slug);
          return objectType?.dateField ? [objectType] : [];
        },
      );
      if (!types.length || from > to) return { from, to, entries: [], truncated: false };
      const bounded = Math.max(1, Math.min(MAX_TIMELINE_RESULTS, Math.trunc(input.limit) || 1));
      const rows = await store.dated(
        tenantId,
        types.map((t) => ({ module: t.module, field: t.dateField ?? '' })),
        from,
        to,
        bounded + 1,
      );
      const entries = rows.slice(0, bounded).flatMap((row) => {
        const objectType = objectTypeForModule(row.module);
        return objectType ? [{ ...summarize(objectType, row), date: row.day }] : [];
      });
      return { from, to, entries, truncated: rows.length > bounded };
    },

    async link(
      tenantId: string,
      input: {
        linkType: string;
        source: { slug: string; id: string };
        target: { slug: string; id: string };
        note: string;
        evidence?: { module: 'fuentes'; id: string } | null;
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
          evidenceSourceId: input.evidence?.id ?? null,
          symmetric: linkType.symmetric,
          createdBy: actor,
          auditDetail: `${source.module} ${source.id} ${linkType.label} ${target.module} ${target.id}`,
        },
        clock.now(),
      );
      return created.ok ? ok(created.id) : err(created.error);
    },

    async classify(tenantId: string, slug: string, id: string, marking: string) {
      const ref = refFor(slug, id);
      if (!ref) return err('missing' as const);
      if (!isMarking(marking)) return err('invalid' as const);
      return (await store.setMarking(tenantId, ref, marking, clock.now()))
        ? ok(marking)
        : err('missing' as const);
    },

    setLinkEvidence: (tenantId: string, id: number, sourceId: string | null) =>
      store.setLinkEvidence(tenantId, id, sourceId, clock.now()),

    unlink: (tenantId: string, id: number) => store.deleteLink(tenantId, id, clock.now()),
  };
};

export type OntologyService = ReturnType<typeof createOntologyService>;
