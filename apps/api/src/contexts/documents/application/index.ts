// Public API of the Document Lab context (docs/adr/0002).
export type { DocxContent, ReviewItem } from '../domain/index.ts';
export {
  DEFAULT_REVIEW_PAGE,
  LAB_REPORT_FILENAME,
  MAX_BULK_DECISION,
  MAX_REVIEW_PAGE,
} from '../domain/index.ts';
export type {
  DocumentReader,
  PdfText,
  PendingSelector,
  ReportRenderer,
  ReviewPage,
  ReviewQuery,
  ReviewRecordWriter,
  ReviewStore,
  TextRecognizer,
} from './ports.ts';
export {
  type BulkDecision,
  type BulkDecisionError,
  createDocumentLabService,
  type DocumentLabService,
  type ImportError,
  type ReadError,
  type ReviewDecision,
  type ReviewListItem,
} from './document-lab-service.ts';
export { type MaterializeReport, materializeApprovedReviews } from './review-materialize.ts';
