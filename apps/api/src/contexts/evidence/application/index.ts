// Public API of the Evidence context (docs/adr/0002).
export type { Attachment } from '../domain/index.ts';
export { ALLOWED_EXTENSIONS, extensionOf, safeUploadName } from '../domain/index.ts';
export type { AttachmentStore, ObjectStorage, TextExtractor } from './ports.ts';
export {
  MAX_LIST_LIMIT,
  PREVIEW_MAX_CHARS,
  PREVIEW_MAX_PAGES,
  type Preview,
  createEvidenceService,
  type Download,
  type EvidenceService,
  type UploadError,
} from './evidence-service.ts';
