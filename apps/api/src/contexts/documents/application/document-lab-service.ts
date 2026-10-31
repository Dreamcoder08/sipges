import { createHash } from 'node:crypto';
import { type Result, err, ok } from '@mascli/kernel';
import { extensionOf, safeUploadName } from '../../evidence/application/index.ts';
import {
  ANALYSIS_LIMITATIONS,
  ANALYSIS_METHOD,
  ANALYSIS_VERSION,
  COMPARE_LIMITATIONS,
  COMPARE_METHOD,
  type DocumentAnalysis,
  type DocumentKind,
  MAX_PDF_PAGES,
  MAX_REVIEW_IMPORT,
  REVIEW_LIMITS,
  type ReviewDecisionError,
  type TextChunk,
  checkDecision,
  compareFindings,
  docxChunks,
  documentInsights,
  documentKindOf,
  labReport,
  pdfChunks,
  recommendationsFor,
  takeCodePoints,
  textChunks,
} from '../domain/index.ts';
import type {
  Clock,
  DocumentReader,
  NewReviewItem,
  RandomHex,
  ReportRenderer,
  ReviewPage,
  ReviewQuery,
  ReviewStore,
} from './ports.ts';

export type DocumentFile = { readonly fileName: string; readonly bytes: Uint8Array };

export type ReadError =
  | { readonly kind: 'extension' }
  | { readonly kind: 'empty' }
  | { readonly kind: 'too_large' }
  | { readonly kind: 'too_many_pages' }
  | { readonly kind: 'unreadable' }
  | { readonly kind: 'no_text' };

export type ImportError =
  { readonly kind: 'sha256' } | { readonly kind: 'too_many' } | { readonly kind: 'invalid_text' };

export type ReviewBatch = {
  readonly projectId: string;
  readonly filename: string;
  readonly sha256: string;
  readonly items: readonly Readonly<Record<string, unknown>>[];
};

const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

/** Python `str(x.get(key, ''))` for the JSON values an item can hold. */
const asText = (value: unknown) =>
  value === undefined || value === null
    ? ''
    : typeof value === 'string'
      ? value
      : typeof value === 'object'
        ? JSON.stringify(value)
        : String(value);

/** PostgreSQL text cannot hold NUL. */
const hasNul = (text: string) => text.includes('\u0000');

export const createDocumentLabService = (deps: {
  reader: DocumentReader;
  renderer: ReportRenderer;
  reviews: ReviewStore;
  clock: Clock;
  randomHex: RandomHex;
  maxUploadBytes: number;
}) => {
  const { reader, renderer, reviews, clock, randomHex, maxUploadBytes } = deps;

  const chunksOf = async (
    kind: DocumentKind,
    bytes: Uint8Array,
  ): Promise<Result<TextChunk[], ReadError>> => {
    try {
      if (kind === 'text') return ok(textChunks(bytes));
      if (kind === 'docx') return ok(docxChunks(await reader.readDocx(bytes)));
      const pdf = await reader.readPdf(bytes, MAX_PDF_PAGES);
      return pdf.kind === 'pages' ? ok(pdfChunks(pdf.pages)) : err({ kind: 'too_many_pages' });
    } catch {
      return err({ kind: 'unreadable' });
    }
  };

  /** Validates and reads one document; the bytes are never stored. */
  const read = async (file: DocumentFile) => {
    const name = safeUploadName(file.fileName || 'documento.txt');
    const kind = documentKindOf(extensionOf(name));
    if (!kind) return err({ kind: 'extension' } as const);
    if (file.bytes.length > maxUploadBytes) return err({ kind: 'too_large' } as const);
    if (file.bytes.length === 0) return err({ kind: 'empty' } as const);
    const chunks = await chunksOf(kind, file.bytes);
    if (!chunks.ok) return chunks;
    if (chunks.value.length === 0) return err({ kind: 'no_text' } as const);
    return ok({
      name,
      sha256: sha256(file.bytes),
      chunks: chunks.value,
      ...documentInsights(chunks.value),
    });
  };

  const analyze = async (
    file: DocumentFile,
    projectId: string,
  ): Promise<Result<DocumentAnalysis, ReadError>> => {
    const doc = await read(file);
    if (!doc.ok) return doc;
    const { name, chunks, items, themes } = doc.value;
    return ok({
      version: ANALYSIS_VERSION,
      project_id: projectId,
      filename: name,
      sha256: doc.value.sha256,
      generated_at: `${clock.now().toISOString().slice(0, 19)}Z`,
      text_sections: chunks.length,
      items,
      themes,
      recommendations: recommendationsFor(themes),
      method: ANALYSIS_METHOD,
      limitations: ANALYSIS_LIMITATIONS,
    });
  };

  return {
    maxUploadBytes,
    reportContentType: renderer.contentType,

    analyze,

    async report(file: DocumentFile, projectId: string) {
      const analysis = await analyze(file, projectId);
      if (!analysis.ok) return analysis;
      return ok(await renderer.render(labReport(analysis.value)));
    },

    /** Same-theme findings of two documents that share distinctive vocabulary. */
    async compare(a: DocumentFile, b: DocumentFile, projectId: string) {
      const docs = [];
      for (const file of [a, b]) {
        const doc = await read(file);
        if (!doc.ok) return doc;
        docs.push(doc.value);
      }
      const [first, second] = docs as [(typeof docs)[0], (typeof docs)[0]];
      const { comparisons, total } = compareFindings(first.items, second.items);
      return ok({
        version: ANALYSIS_VERSION,
        project_id: projectId,
        documents: docs.map((d) => ({ filename: d.name, sha256: d.sha256 })),
        comparaciones: comparisons,
        total_candidatos: total,
        method: COMPARE_METHOD,
        limitations: COMPARE_LIMITATIONS,
      });
    },

    /** Stores review excerpts only (never the document); duplicates are skipped. */
    async importReview(tenantId: string, batch: ReviewBatch): Promise<Result<number, ImportError>> {
      if (!/^[0-9a-f]{64}$/.test(batch.sha256)) return err({ kind: 'sha256' });
      if (batch.items.length > MAX_REVIEW_IMPORT) return err({ kind: 'too_many' });
      const at = clock.now();
      const rows: NewReviewItem[] = [];
      for (const item of batch.items) {
        const theme = takeCodePoints(asText(item.tema), REVIEW_LIMITS.theme);
        const excerpt = takeCodePoints(asText(item.fragmento), REVIEW_LIMITS.excerpt);
        const location = takeCodePoints(asText(item.ubicacion), REVIEW_LIMITS.location);
        const action = takeCodePoints(asText(item.accion_sugerida), REVIEW_LIMITS.action);
        if (!excerpt || !location) continue;
        rows.push({
          id: randomHex(32).toLowerCase(),
          projectId: takeCodePoints(batch.projectId, REVIEW_LIMITS.projectId),
          sourceFile: takeCodePoints(batch.filename, REVIEW_LIMITS.sourceFile),
          sourceSha256: batch.sha256,
          location,
          theme,
          excerpt,
          action,
          createdAt: at,
        });
      }
      const texts = rows.flatMap((r) => [
        r.projectId,
        r.sourceFile,
        r.location,
        r.theme,
        r.excerpt,
        r.action,
      ]);
      if (texts.some(hasNul)) return err({ kind: 'invalid_text' });
      return ok(rows.length === 0 ? 0 : await reviews.importItems(tenantId, rows));
    },

    listReview(tenantId: string, query: ReviewQuery): Promise<ReviewPage> {
      const texts = [query.projectId, query.status ?? '', query.theme ?? ''];
      if (texts.some(hasNul)) return Promise.resolve({ items: [], total: 0, themes: {} });
      return reviews.list(tenantId, {
        ...query,
        status: query.status || null,
        theme: query.theme || null,
      });
    },

    async decide(
      tenantId: string,
      input: { id: string; status: string; reviewer: string; note: string },
    ): Promise<Result<{ id: string; status: string }, ReviewDecisionError>> {
      const checked = checkDecision(input.status, input.note);
      if (!checked.ok) return err(checked.error);
      if (hasNul(input.id) || input.id.length > 64) return err({ kind: 'missing' });
      const reviewer = takeCodePoints(input.reviewer, REVIEW_LIMITS.reviewer);
      const note = takeCodePoints(input.note, REVIEW_LIMITS.note);
      if (hasNul(reviewer) || hasNul(note)) return err({ kind: 'invalid_text' });
      const found = await reviews.decide(tenantId, {
        id: input.id,
        status: checked.status,
        reviewer,
        note,
        at: clock.now(),
      });
      return found ? ok({ id: input.id, status: checked.status }) : err({ kind: 'missing' });
    },
  };
};

export type DocumentLabService = ReturnType<typeof createDocumentLabService>;
