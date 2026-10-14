// Public API of the Integration context (docs/adr/0014 §6-7).
export {
  type ApiPrincipal,
  KEY_ACCESS,
  KEY_CLEARANCE,
  type KeyAccess,
  type KeyClearance,
  bearerToken,
  keyActor,
  payloadProject,
} from '../domain/api-key.ts';
export {
  MAX_INGEST_RECORDS,
  formPayload,
  idempotencyKey,
  ingestPayloads,
} from '../domain/ingest.ts';
export type {
  ApiKeyStore,
  IngestClaim,
  IngestReceipts,
  IngestResponse,
  KeyCrypto,
  StoredKey,
} from './ports.ts';
export { type ApiKeyService, createApiKeyService } from './api-key-service.ts';
export {
  type IngestOutcome,
  type IngestRequest,
  type IngestService,
  createIngestService,
} from './ingest-service.ts';
