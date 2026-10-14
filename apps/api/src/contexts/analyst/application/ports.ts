import type { Connection, Subject } from '../domain/briefing.ts';

/** The record and its visible connections, read through the Ontology context. */
export type BriefingSource = {
  neighbours(
    tenantId: string,
    slug: string,
    id: string,
  ): Promise<{ subject: Subject; connections: Connection[] } | null>;
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
