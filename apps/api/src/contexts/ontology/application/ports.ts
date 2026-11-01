import type { SanitisedPayload } from '../../privacy/application/index.ts';

/** A record by stored module name and id. */
export type NodeRef = { readonly module: string; readonly id: string };

export type NodeRow = NodeRef & {
  readonly payload: Readonly<Record<string, unknown>>;
  readonly marking: string;
  readonly updatedAt: Date;
};

export type StoredLink = {
  readonly id: number;
  readonly linkType: string;
  readonly source: NodeRef;
  readonly target: NodeRef;
  readonly note: string;
  readonly createdBy: string;
  readonly createdAt: Date;
  readonly evidenceSourceId?: string | null;
};

/** An inference rule with stored module names, ready for the adapter. */
export type ResolvedRule = {
  readonly index: number;
  readonly holderModule: string;
  readonly field: string;
  readonly targetModule: string;
  readonly match: 'id' | 'title';
  readonly targetTitleField: string;
};

/** A holder record whose `field` resolved to a target record under rule `index`. */
export type InferredMatch = {
  readonly index: number;
  readonly holder: NodeRef;
  readonly target: NodeRef;
};

export type NewLink = {
  readonly linkType: string;
  readonly source: NodeRef;
  readonly target: NodeRef;
  readonly note: string;
  readonly symmetric: boolean;
  readonly createdBy: string;
  readonly auditDetail: string;
  readonly evidenceSourceId?: string | null;
};

/** Every call runs in one tenant transaction (docs/adr/0003). */
export type OntologyStore = {
  nodes(tenantId: string, refs: readonly NodeRef[]): Promise<NodeRow[]>;
  /** Records of `modules` whose id equals `exactId` or that match a prefix tsquery. */
  search(
    tenantId: string,
    query: string | null,
    exactId: string,
    modules: readonly string[],
    limit: number,
  ): Promise<NodeRow[]>;
  /**
   * Records whose date field (per module, ISO yyyy-mm-dd prefix) falls in [from, to], newest
   * first, with that day.
   */
  dated(
    tenantId: string,
    fields: readonly { module: string; field: string }[],
    from: string,
    to: string,
    limit: number,
  ): Promise<(NodeRow & { day: string })[]>;
  /** The most recently updated records of `modules`, for entity resolution in text. */
  recent(tenantId: string, modules: readonly string[], limit: number): Promise<NodeRow[]>;
  /** Explicit links with either end in `refs`. */
  links(tenantId: string, refs: readonly NodeRef[]): Promise<StoredLink[]>;
  /** Inferred matches with either end in `refs`. */
  inferred(
    tenantId: string,
    refs: readonly NodeRef[],
    rules: readonly ResolvedRule[],
  ): Promise<InferredMatch[]>;
  /** Audits the creation; symmetric links also count as duplicates when stored reversed. */
  createLink(
    tenantId: string,
    link: NewLink,
    at: Date,
  ): Promise<{ ok: true; id: number } | { ok: false; error: 'missing' | 'duplicate' }>;
  setLinkEvidence(
    tenantId: string,
    id: number,
    sourceId: string | null,
    at: Date,
  ): Promise<boolean>;
  /** Sets a record's marking and audits it; false when the record is not visible. */
  setMarking(tenantId: string, ref: NodeRef, marking: string, at: Date): Promise<boolean>;
  /** Audits the deletion; false when absent. */
  deleteLink(tenantId: string, id: number, at: Date): Promise<boolean>;
};

export type Clock = { now(): Date };

/** A record with its text, ready to embed. */
export type EmbeddingSource = NodeRef & {
  readonly payload: Readonly<Record<string, unknown>>;
  readonly marking: string;
  /** Opaque version of the payload, stored with the vector to detect changes. */
  readonly hash: string;
};

/** Stored record embeddings (docs/adr/0014 §9); every call runs in one tenant transaction. */
export type EmbeddingIndex = {
  /**
   * Records without an embedding from `model`, or changed since it was computed, oldest
   * first. Restricted records are never embedded, so their text never reaches the model.
   */
  stale(tenantId: string, model: string, limit: number): Promise<EmbeddingSource[]>;
  save(
    tenantId: string,
    rows: readonly (NodeRef & { vector: readonly number[]; hash: string })[],
    model: string,
    at: Date,
  ): Promise<void>;
  /** Visible records of `modules` with an embedding from `model`. */
  vectors(
    tenantId: string,
    modules: readonly string[],
    model: string,
    limit: number,
  ): Promise<(NodeRef & { vector: number[] })[]>;
};

export type Embedder = {
  readonly model: string;
  /** `local`: loopback, not egress. Anything else goes through the egress guard first. */
  readonly egress: 'local' | 'external';
  embed(text: SanitisedPayload<string>): Promise<number[]>;
};
