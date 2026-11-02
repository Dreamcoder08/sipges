// Public API of the Document Lab context (docs/adr/0002).
export type { DocxContent, ReviewItem } from '../domain/index.ts';
export { DEFAULT_REVIEW_PAGE, LAB_REPORT_FILENAME, MAX_REVIEW_PAGE } from '../domain/index.ts';
export type {
  DocumentReader,
  PdfText,
  ReportRenderer,
  ReviewPage,
  ReviewQuery,
  ReviewRecordWriter,
  ReviewStore,
  TextRecognizer,
} from './ports.ts';
export {
  createDocumentLabService,
  type DocumentLabService,
  type ImportError,
  type ReadError,
  type ReviewDecision,
  type ReviewListItem,
} from './document-lab-service.ts';
