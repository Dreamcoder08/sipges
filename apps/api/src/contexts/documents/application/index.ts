// Public API of the Document Lab context (docs/adr/0002).
export type { DocxContent, ReviewItem } from '../domain/index.ts';
export { LAB_REPORT_FILENAME } from '../domain/index.ts';
export type {
  DocumentReader,
  PdfText,
  ReportRenderer,
  ReviewStore,
  TextRecognizer,
} from './ports.ts';
export {
  createDocumentLabService,
  type DocumentLabService,
  type ImportError,
  type ReadError,
} from './document-lab-service.ts';
