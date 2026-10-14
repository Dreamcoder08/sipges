import { z } from 'zod';

/** PostgreSQL jsonb/text cannot hold NUL anywhere: keys or string values, at any depth. */
const hasNul = (value: unknown): boolean => {
  if (typeof value === 'string') return value.includes('\u0000');
  if (Array.isArray(value)) return value.some(hasNul);
  if (typeof value === 'object' && value !== null) {
    return Object.entries(value).some(([key, inner]) => key.includes('\u0000') || hasNul(inner));
  }
  return false;
};

/** POST/PUT /api/{module} body (app.py RecordIn); extra payload fields stay free-form. */
export const RecordIn = z.object({
  payload: z
    .record(z.string(), z.unknown(), { error: 'Payload must be an object' })
    .refine((payload) => !hasNul(payload), { message: 'Text must not contain NUL characters' }),
});
export type RecordIn = z.infer<typeof RecordIn>;

export const RecordCreated = z.object({ ok: z.literal(true), id: z.string() });
export type RecordCreated = z.infer<typeof RecordCreated>;

/** One GET /system/audit row (app.py audit table columns). */
export const AuditEntry = z.object({
  id: z.number(),
  ts: z.string(),
  module: z.string(),
  record_id: z.string().nullable(),
  action: z.string(),
  detail: z.string().nullable(),
});
export type AuditEntry = z.infer<typeof AuditEntry>;

/** Territorial payload plus HTTP identity metadata; arbitrary payload fields are preserved. */
export const ModuleRecord = z.looseObject({
  _id: z.string(),
  _updated_at: z.string().optional(),
});
export type ModuleRecord = z.infer<typeof ModuleRecord>;

/** Record provenance shared with the API domain (packages/kernel). */
export { type RecordOrigin, isDemoRecord, recordOrigin } from '@mascli/kernel';

/** One field difference against the previous version (`before`/`after` absent = no value). */
export const FieldChange = z.object({
  field: z.string(),
  before: z.unknown().optional(),
  after: z.unknown().optional(),
});
export type FieldChange = z.infer<typeof FieldChange>;

/** GET /api/{module}/{id}/history item, newest first (docs/adr/0011 §4). */
export const RecordVersion = z.object({
  version: z.number().int().positive(),
  operation: z.enum(['BASELINE', 'CREATE', 'UPDATE', 'DELETE']),
  actor: z.string(),
  at: z.string(),
  payload: z.record(z.string(), z.unknown()).nullable(),
  changes: z.array(FieldChange),
});
export type RecordVersion = z.infer<typeof RecordVersion>;

/** POST /system/import/{module}: rows already mapped to field names (spreadsheet import). */
export const ImportIn = z.object({
  rows: z.array(z.record(z.string(), z.string())).max(2000),
  dry_run: z.boolean().default(true),
  source: z.string().max(200).default(''),
});
export type ImportIn = z.infer<typeof ImportIn>;

export const ImportReport = z.object({
  applied: z.boolean(),
  created: z.number().int(),
  updated: z.number().int(),
  problems: z.array(z.object({ row: z.number().int(), message: z.string() })),
});
export type ImportReport = z.infer<typeof ImportReport>;
