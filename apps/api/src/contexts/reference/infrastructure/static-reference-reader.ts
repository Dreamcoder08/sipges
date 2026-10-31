import { CanonicalEntities, ProjectCoordinates } from '@mascli/contracts';
import type { ReferenceReader } from '../application/index.ts';

type Scope = { companyId: string; projectId: string };
/** Trusted repository references are registered to one tenant, never used as a fallback. */
export const isRegisteredReferenceScope = (scope: Scope) =>
  scope.companyId === 'MASCLI' && scope.projectId === 'PRJ-SECHURA';

/**
 * The repository references from data already in memory, for runtimes without a filesystem
 * (Cloudflare Workers bundle the JSON). Same contracts and tenant rule as the file reader.
 */
export const staticReferenceReader = (raw: {
  coordinates: unknown;
  entities: unknown;
}): ReferenceReader => ({
  coordinates: async (scope) =>
    isRegisteredReferenceScope(scope) ? ProjectCoordinates.parse(raw.coordinates) : null,
  entities: async (scope) =>
    isRegisteredReferenceScope(scope) ? CanonicalEntities.parse(raw.entities) : null,
});
