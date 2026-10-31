import type { ReportDocument } from '@mascli/kernel';
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

export type ReviewStore = {
  /** Inserts items, skipping exact duplicates; returns how many rows were new. */
  importItems(tenantId: string, items: readonly NewReviewItem[]): Promise<number>;
  list(tenantId: string, query: ReviewQuery): Promise<ReviewPage>;
  /** Updates one item and writes its audit row in the same transaction; false when missing. */
  decide(
    tenantId: string,
    decision: {
      id: string;
      status: ReviewStatus;
      reviewer: string;
      note: string;
      at: Date;
    },
  ): Promise<boolean>;
};

/** Optional OCR for scanned PDFs: one text per page, in page order. */
export type TextRecognizer = {
  recognizePdf(bytes: Uint8Array): Promise<string[]>;
};
