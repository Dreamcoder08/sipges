import type { ReportDocument } from '@mascli/kernel';
import type { Scope } from '../../tenancy/application/index.ts';
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
