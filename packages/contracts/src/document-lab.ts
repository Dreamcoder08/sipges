import { z } from 'zod';

/** Located lexical candidates; these are never automatically corroborated facts. */
export const DocumentFinding = z.strictObject({
  id: z.string(),
  tema: z.string(),
  ubicacion: z.string(),
  fragmento: z.string(),
  terminos: z.array(z.string()),
  accion_sugerida: z.string(),
  estado: z.literal('Candidato no verificado'),
});
export const DocumentAnalysisResponse = z.strictObject({
  version: z.literal('2.1'),
  project_id: z.string(),
  filename: z.string(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  generated_at: z.string(),
  text_sections: z.number().int(),
  items: z.array(DocumentFinding).max(75),
  themes: z.record(z.string(), z.number().int()),
  recommendations: z.array(
    z.strictObject({
      tema: z.string(),
      accion: z.string(),
      hallazgos_candidatos: z.number().int(),
    }),
  ),
  method: z.string(),
  limitations: z.array(z.string()),
});
export type DocumentAnalysisResponse = z.infer<typeof DocumentAnalysisResponse>;
const LocatedExcerpt = z.strictObject({ ubicacion: z.string(), fragmento: z.string() });
export const DocumentComparisonResponse = z.strictObject({
  version: z.literal('2.1'),
  project_id: z.string(),
  documents: z.array(z.strictObject({ filename: z.string(), sha256: z.string() })).length(2),
  comparaciones: z
    .array(
      z.strictObject({
        tema: z.string(),
        a: LocatedExcerpt,
        b: LocatedExcerpt,
        terminos_comunes: z.array(z.string()),
        coincidencia_lexica: z.number(),
        tipo: z.string(),
        advertencia: z.string(),
      }),
    )
    .max(40),
  total_candidatos: z.number().int(),
  method: z.string(),
  limitations: z.array(z.string()),
});
export const DocumentReviewStatus = z.enum([
  'pendiente',
  'aceptado_para_revision',
  'descartado',
  'corroborado_documentalmente',
]);
export type DocumentReviewStatus = z.infer<typeof DocumentReviewStatus>;
export const DocumentReviewItem = z.strictObject({
  id: z.string(),
  project_id: z.string(),
  source_file: z.string(),
  source_sha256: z.string(),
  location: z.string(),
  theme: z.string(),
  excerpt: z.string(),
  action: z.string(),
  status: DocumentReviewStatus,
  reviewer: z.string(),
  note: z.string(),
  created_at: z.string(),
  updated_at: z.string(),
  /** Records module (URL slug and label) an approval of this item writes to. */
  target: z.strictObject({ module: z.string(), label: z.string() }).optional(),
  /** The record its approval created, once it exists. */
  record: z.strictObject({ module: z.string(), id: z.string() }).nullable().optional(),
});
export type DocumentReviewItem = z.infer<typeof DocumentReviewItem>;
export const DocumentReviewResponse = z.strictObject({
  items: z.array(DocumentReviewItem),
  /** Full count matching the filters, not the page length. */
  total: z.number().int(),
  limit: z.number().int(),
  offset: z.number().int(),
  /** Theme → items matching project and status, ignoring the theme filter. */
  themes: z.record(z.string(), z.number().int()),
  limitations: z.string(),
});
export const DocumentReviewImportResponse = z.strictObject({
  ok: z.literal(true),
  new_items: z.number().int(),
  message: z.string(),
});
export const DocumentReviewDecisionResponse = z.strictObject({
  ok: z.literal(true),
  id: z.string(),
  status: DocumentReviewStatus,
  /** Approvals create a record once (`created` false when it already existed); else null. */
  record: z
    .strictObject({ module: z.string(), id: z.string(), created: z.boolean() })
    .nullable()
    .optional(),
});
/** Decisions a bulk request may take: approving or discarding, never back to «pendiente». */
export const DocumentReviewBulkStatus = z.enum([
  'aceptado_para_revision',
  'corroborado_documentalmente',
  'descartado',
]);
/**
 * Decides many pending items at once (functional-closure T26): explicit `ids`, or the pending
 * items of a `theme` and/or `source_sha256`, never both. At most 1,000 per request.
 */
export const DocumentReviewBulkRequest = z
  .strictObject({
    // Over 1,000 is refused by the API with its own message; this only bounds the body.
    ids: z.array(z.string().max(64)).min(1).max(5000).optional(),
    theme: z.string().max(140).optional(),
    source_sha256: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .optional(),
    status: DocumentReviewBulkStatus,
    note: z.string().max(1500).default(''),
    /** Counts what would be decided and created, writing nothing. */
    dry_run: z.boolean().default(false),
  })
  .refine(
    (body) =>
      (body.ids === undefined) !== (body.theme === undefined && body.source_sha256 === undefined),
    { message: 'Indique ids o un filtro por tema o documento, no ambos' },
  );
export type DocumentReviewBulkRequest = z.input<typeof DocumentReviewBulkRequest>;
export const DocumentReviewBulkResponse = z.strictObject({
  ok: z.literal(true),
  dry_run: z.boolean(),
  /** Items decided (or, in a dry run, that would be). */
  decided: z.number().int(),
  records_created: z.number().int(),
  /** Requested ids not pending in this project (already decided or not found). */
  skipped: z.number().int(),
  /** Pending items of the filter left for another request after the cap. */
  remaining: z.number().int(),
  modules: z.array(
    z.strictObject({
      module: z.string(),
      label: z.string(),
      nuevos: z.number().int(),
      ya_existentes: z.number().int(),
    }),
  ),
  problems: z.array(z.string()),
});
export type DocumentReviewBulkResponse = z.infer<typeof DocumentReviewBulkResponse>;
