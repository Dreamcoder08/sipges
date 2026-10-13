// Public API of the Evidence context (docs/adr/0002).
export type { Attachment } from '../domain/index.ts';
export { ALLOWED_EXTENSIONS } from '../domain/index.ts';
export type { AttachmentStore, ObjectStorage } from './ports.ts';
export {
  MAX_LIST_LIMIT,
  createEvidenceService,
  type Download,
  type EvidenceService,
  type UploadError,
} from './evidence-service.ts';
