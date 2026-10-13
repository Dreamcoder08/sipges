// Public API of the Territorial Records context (docs/adr/0002).
export {
  type ModuleName,
  type Payload,
  moduleForSlug,
  validatePayload,
} from '../domain/modules.ts';
export type { StoredRecord } from './ports.ts';
export {
  MAX_LIMIT,
  boundLimit,
  createRecordsService,
  type RecordsService,
} from './records-service.ts';
