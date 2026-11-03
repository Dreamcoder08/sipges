/**
 * Per-context parity cases and fixtures. A context ported to Go adds one module here with its
 * `cases` and the synthetic `seed` SQL they read; cases.ts and fixtures.ts pick them up.
 */
import type { ParityCase } from '../types.ts';
import * as audit from './audit.ts';
import * as geography from './geography.ts';
import * as management from './management.ts';
import * as prevention from './prevention.ts';
import * as reference from './reference.ts';
import * as situations from './situations.ts';

const CONTEXTS = [audit, geography, management, prevention, situations, reference];

export const CONTEXT_CASES: readonly ParityCase[] = CONTEXTS.flatMap((c) => c.cases);
export const SEEDS: readonly string[] = CONTEXTS.map((c) => c.seed).filter(Boolean);
