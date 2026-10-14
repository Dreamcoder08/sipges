// Public API of the Territorial Records context (docs/adr/0002).
export {
  type ModuleName,
  type Payload,
  moduleForSlug,
  validatePayload,
} from '../domain/modules.ts';
export type { StoredRecord } from './ports.ts';
export { type FieldChange, diffPayloads } from '../domain/history.ts';
export { MAX_IMPORT_ROWS, isImportable } from '../domain/import.ts';
export {
  MAX_LIMIT,
  boundLimit,
  createRecordsService,
  type ImportReport,
  type RecordVersion,
  type RecordsService,
} from './records-service.ts';
