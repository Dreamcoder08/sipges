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
