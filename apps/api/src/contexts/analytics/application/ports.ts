import type { ReportDocument } from '@sipges/kernel';
import type { Scope } from '../../tenancy/application/index.ts';
import type { IrsaPoint, RiskAlert, RiskRecord } from '../domain/conflict-risk/index.ts';
import type { RecordsByModule } from '../domain/records.ts';

/**
 * Read-only access to the tenant's module records. Returns one entry per requested module,
 * newest first, and empty lists when no records (or no records table) exist yet.
 */
export type AnalyticsRecordReader = {
  read(scope: Scope, modules: readonly string[]): Promise<RecordsByModule>;
};

export type Clock = { now(): Date };

/** Turns a format-neutral report outline into a downloadable file (DOCX in production). */
export type ReportRenderer = {
  readonly contentType: string;
  render(document: ReportDocument): Promise<Uint8Array>;
};

/**
 * Inputs of the conflict-risk prediction (docs/adr/0031 §5): the scope's records with their last
 * update, its territorial alerts (Digital Intelligence) and IRSA snapshots (Indicators & IRSA).
 * Each source is read for the scope's tenant only; compose.ts wires them to those contexts.
 */
export type ConflictRiskSources = {
  records(scope: Scope, modules: readonly string[]): Promise<readonly RiskRecord[]>;
  alerts(scope: Scope): Promise<readonly RiskAlert[]>;
  irsa(scope: Scope): Promise<readonly IrsaPoint[]>;
};
