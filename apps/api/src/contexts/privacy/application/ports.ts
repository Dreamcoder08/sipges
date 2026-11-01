import type { KnownName, Mac } from '../domain/pseudonyms.ts';

export type Clock = { now(): Date };

/** The project's «Envío a IA externa» switch; off until an administrator turns it on. */
export type ExternalAiSwitch = { enabled(tenantId: string): Promise<boolean> };

/** The project's own people and organisations, read with full clearance so none is missed. */
export type NameDirectory = { load(tenantId: string): Promise<readonly KnownName[]> };

/** One line of the access log: what left, never its content. */
export type EgressLogEntry = { readonly detail: string; readonly at: Date };

/** Appends to the project's audit trail; it fails the release when it cannot write. */
export type EgressLog = { append(tenantId: string, entry: EgressLogEntry): Promise<void> };

/** Per-project keyed hash derived from SIPGES_DATA_KEY; the key itself never leaves the adapter. */
export type PseudonymKeys = { macFor(tenantId: string): Mac };
