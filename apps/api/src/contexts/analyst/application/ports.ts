import type { Connection, Subject } from '../domain/briefing.ts';
import type { MentionFound, ProposedLink, ProposedRecord } from '../domain/proposals.ts';

/** The record and its visible connections, read through the Ontology context. */
export type BriefingSource = {
  neighbours(
    tenantId: string,
    slug: string,
    id: string,
  ): Promise<{ subject: Subject; connections: Connection[] } | null>;
  /** Unlinked records named in the subject's text or naming it in theirs. */
  mentions(tenantId: string, slug: string, id: string): Promise<MentionFound[] | null>;
};

/** Writes an approved proposal through the owning contexts, which audit it. */
export type ProposalActions = {
  link(
    tenantId: string,
    link: ProposedLink,
    note: string,
    actor: string,
  ): Promise<'created' | 'duplicate' | 'failed'>;
  /** The new record's id, or null when it could not be created. */
  create(tenantId: string, record: ProposedRecord): Promise<string | null>;
};

export type ProposalDecision = {
  readonly fingerprint: string;
  readonly subject: { readonly slug: string; readonly id: string };
  readonly kind: 'link' | 'record';
  readonly decision: 'approved' | 'rejected';
  /** What the approval produced (`slug/id` of a new record), for the audit trail. */
  readonly result: string | null;
  readonly title: string;
  readonly actor: string;
  readonly at: Date;
};

export type ProposalStore = {
  /** Fingerprints among `fingerprints` someone already decided. */
  decided(tenantId: string, fingerprints: readonly string[]): Promise<Set<string>>;
  /** Stores the decision with its audit row; false when it was already decided. */
  save(tenantId: string, decision: ProposalDecision): Promise<boolean>;
};

/**
 * Rewrites an extractive briefing as prose (docs/adr/0013). It receives only the briefing text,
 * never raw records, and must cite with the briefing's [n] markers.
 */
export type Narrator = {
  readonly name: string;
  narrate(briefing: string, signal: AbortSignal): Promise<string>;
};

export type Clock = { now(): Date };
