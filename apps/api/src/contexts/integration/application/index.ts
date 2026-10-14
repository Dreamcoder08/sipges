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
export type { ApiKeyStore, KeyCrypto, StoredKey } from './ports.ts';
export { type ApiKeyService, createApiKeyService } from './api-key-service.ts';
