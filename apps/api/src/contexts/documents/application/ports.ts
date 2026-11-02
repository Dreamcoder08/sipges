import type { ReportDocument } from '@sipges/kernel';
import type { DocxContent, ReviewItem, ReviewStatus } from '../domain/index.ts';

export type Clock = { now(): Date };
export type RandomHex = (length: number) => string;

export type PdfText =
  | { readonly kind: 'pages'; readonly pages: readonly string[] }
  | { readonly kind: 'too_many_pages' };

/**
 * Parses untrusted document bytes into plain text. Implementations throw on unreadable input;
 * the use case turns that into a 422 without exposing parser internals.
 */
export type DocumentReader = {
  /** Page texts, or `too_many_pages` before any page beyond `maxPages` is read. */
  readPdf(bytes: Uint8Array, maxPages: number): Promise<PdfText>;
  readDocx(bytes: Uint8Array): Promise<DocxContent>;
};

/** Turns a format-neutral report outline into a downloadable file. */
export type ReportRenderer = {
  readonly contentType: string;
  render(document: ReportDocument): Promise<Uint8Array>;
};

export type NewReviewItem = Omit<ReviewItem, 'status' | 'reviewer' | 'note' | 'updatedAt'>;

export type ReviewQuery = {
  projectId: string;
  status: string | null;
  theme: string | null;
  limit: number;
  offset: number;
};

export type ReviewPage = {
  items: ReviewItem[];
  /** Rows matching every filter, regardless of the page. */
  total: number;
  /** Theme → rows matching project and status only. */
  themes: Record<string, number>;
};

/** Pending items of one project: explicit ids, or a theme and/or source document (null = any). */
export type PendingSelector = {
  projectId: string;
  ids: readonly string[] | null;
  theme: string | null;
  sourceSha256: string | null;
};

export type ReviewStore = {
  /** Inserts items, skipping exact duplicates; returns how many rows were new. */
  importItems(tenantId: string, items: readonly NewReviewItem[]): Promise<number>;
  list(tenantId: string, query: ReviewQuery): Promise<ReviewPage>;
  /** Updates one item and writes its audit row in the same transaction; null when missing. */
  decide(
    tenantId: string,
    decision: {
      id: string;
      status: ReviewStatus;
      reviewer: string;
      note: string;
      at: Date;
    },
  ): Promise<ReviewItem | null>;
  /** Pending items matching the selector, in id order, at most `limit`. */
  pending(tenantId: string, selector: PendingSelector, limit: number): Promise<ReviewItem[]>;
  countPending(tenantId: string, selector: PendingSelector): Promise<number>;
  /**
   * Decides up to `limit` items that are still pending in one transaction, each with the same
   * audit row as `decide`; items decided meanwhile are left alone. Returns the decided items.
   */
  decidePending(
    tenantId: string,
    selector: PendingSelector,
    decision: { status: ReviewStatus; reviewer: string; note: string; at: Date },
    limit: number,
  ): Promise<ReviewItem[]>;
  /** Approved items (any project of the tenant) with an id after `afterId`, in id order. */
  approved(tenantId: string, page: { afterId: string; limit: number }): Promise<ReviewItem[]>;
};

/**
 * The records context, seen from the document lab (docs/adr/0002: documents never write
 * `module_records`). `module` is a records URL slug such as `actores`.
 */
export type ReviewRecordWriter = {
  /**
   * Insert-only under the given ids, validated and normalized like a records import; ids already
   * stored are counted as `existing` and left untouched. A dry run writes nothing.
   */
  createMissing(
    tenantId: string,
    module: string,
    items: readonly { id: string; fields: Readonly<Record<string, string>> }[],
    options: { dryRun: boolean; source: string },
  ): Promise<{ created: number; existing: number; problems: readonly string[] }>;
  existing(tenantId: string, module: string, ids: readonly string[]): Promise<Set<string>>;
};

/** Optional OCR for scanned PDFs: one text per page, in page order. */
export type TextRecognizer = {
  recognizePdf(bytes: Uint8Array): Promise<string[]>;
};
