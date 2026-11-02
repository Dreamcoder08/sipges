/** Verification inbox of document findings (app.py:1813-1874, RC 2.1). */

export const REVIEW_STATUSES = [
  'pendiente',
  'aceptado_para_revision',
  'descartado',
  'corroborado_documentalmente',
] as const;

export type ReviewStatus = (typeof REVIEW_STATUSES)[number];

export const isReviewStatus = (value: string): value is ReviewStatus =>
  (REVIEW_STATUSES as readonly string[]).includes(value);

export const MAX_REVIEW_IMPORT = 75;
export const DEFAULT_REVIEW_PAGE = 50;
export const MAX_REVIEW_PAGE = 200;
/** One bulk request decides at most this many items, in transactions of `BULK_BATCH` (T26). */
export const MAX_BULK_DECISION = 1000;
export const BULK_BATCH = 200;

export const REVIEW_LIMITS = {
  projectId: 120,
  sourceFile: 200,
  location: 140,
  theme: 140,
  excerpt: 480,
  action: 500,
  reviewer: 120,
  note: 1500,
} as const;

export type ReviewItem = {
  readonly id: string;
  readonly projectId: string;
  readonly sourceFile: string;
  readonly sourceSha256: string;
  readonly location: string;
  readonly theme: string;
  readonly excerpt: string;
  readonly action: string;
  readonly status: ReviewStatus;
  readonly reviewer: string;
  readonly note: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
};

export type ReviewDecisionError =
  | { readonly kind: 'status' }
  | { readonly kind: 'note_required' }
  | { readonly kind: 'missing' }
  | { readonly kind: 'invalid_text' };

/** Corroboration must name the evidence that was checked. */
export const checkDecision = (
  status: string,
  note: string,
): { ok: true; status: ReviewStatus } | { ok: false; error: ReviewDecisionError } => {
  if (!isReviewStatus(status)) return { ok: false, error: { kind: 'status' } };
  if (status === 'corroborado_documentalmente' && !note.trim())
    return { ok: false, error: { kind: 'note_required' } };
  return { ok: true, status };
};
