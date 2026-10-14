import {
  Attachment,
  AttachmentUploaded,
  CurrentScope,
  ModuleRecord,
  RecordCreated,
} from '@mascli/contracts';
import { z } from 'zod';
import { academicDemo } from './dataset.ts';
import { planDemoImport } from './plan.ts';
import { renderDemoEvidence } from './documents.ts';

export type DemoRequest = (
  method: 'GET' | 'POST',
  path: string,
  body?: unknown,
) => Promise<unknown>;

/** Import only this explicitly scoped synthetic dataset; default is read-only planning. */
export const seedDemo = async (request: DemoRequest, apply = false) => {
  const data = academicDemo();
  const scope = CurrentScope.parse(await request('GET', '/system/auth/current-scope'));
  if (scope.scope !== data.scope)
    throw new Error('Select the academic demo scope before importing');
  const existing: Record<string, Record<string, unknown>[]> = {};
  for (const module of new Set(data.records.map((r) => r.module))) {
    const rows = z.array(ModuleRecord).parse(await request('GET', `/api/${module}?limit=-1`));
    existing[module] = rows;
    // The API caps negative/unbounded requests at 500: do not treat that as a complete scan.
    if (rows.length >= 500) throw new Error('Truncated inventory: completeness cannot be proven');
  }
  const plan = planDemoImport(data, existing);
  if (!apply) return { created: 0, skipped: plan.skip.length, pending: plan.create.length };
  for (const row of plan.create) {
    RecordCreated.parse(await request('POST', `/api/${row.module}`, { payload: row.payload }));
  }
  return { created: plan.create.length, skipped: plan.skip.length, pending: 0 };
};

/** Adds real evidence only after records exist, preserving previously imported files. */
export const seedDemoEvidence = async (request: DemoRequest) => {
  const data = academicDemo();
  const scope = CurrentScope.parse(await request('GET', '/system/auth/current-scope'));
  if (scope.scope !== data.scope)
    throw new Error('Select the academic demo scope before importing');
  const files = z
    .array(Attachment)
    .parse(await request('GET', '/system/uploads?linked_module=fuentes&limit=500'));
  if (files.length >= 500)
    throw new Error('Truncated evidence inventory: completeness cannot be proven');
  let evidenceCreated = 0;
  let evidenceSkipped = 0;
  for (const file of data.evidence) {
    const marker = `${data.version}:${file.recordId}`;
    const matching = files.filter(
      (existing) =>
        existing.linked_record_id === file.recordId && existing.original_name === file.filename,
    );
    if (matching.length > 1) throw new Error('Duplicate demo evidence');
    if (matching.length === 1) {
      if (!matching[0]?.notes.includes(marker))
        throw new Error('Reserved evidence filename collision');
      evidenceSkipped++;
      continue;
    }
    const type =
      file.format === 'pdf'
        ? 'application/pdf'
        : file.format === 'docx'
          ? 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
          : 'text/plain';
    const form = new FormData();
    form.set('file', new File([await renderDemoEvidence(file)], file.filename, { type }));
    form.set('linked_module', 'fuentes');
    form.set('linked_record_id', file.recordId);
    form.set('document_type', 'Evidencia académica sintética');
    form.set('author', 'Equipo académico sintético MASCLI');
    form.set('verification', 'C - Parcial');
    form.set('notes', `DATOS SINTÉTICOS. Verificación simulada. ${marker}`);
    AttachmentUploaded.parse(await request('POST', '/system/uploads', form));
    evidenceCreated++;
  }
  return { evidenceCreated, evidenceSkipped };
};
