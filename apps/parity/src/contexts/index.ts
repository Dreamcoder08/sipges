/**
 * Per-context parity cases and fixtures. A context ported to Go adds one file next to this one
 * exporting its `cases` and the synthetic `seed` SQL they read; it is discovered by file name, so
 * this file never changes when a context is added. cases.ts and fixtures.ts pick them up.
 */
import { loadContexts } from '../discover.ts';
import type { ParityCase } from '../types.ts';

const CONTEXTS = await loadContexts(import.meta.dirname);

export const CONTEXT_NAMES: readonly string[] = CONTEXTS.map((c) => c.name);
export const CONTEXT_CASES: readonly ParityCase[] = CONTEXTS.flatMap((c) => c.cases);
export const SEEDS: readonly string[] = CONTEXTS.map((c) => c.seed).filter(Boolean);
