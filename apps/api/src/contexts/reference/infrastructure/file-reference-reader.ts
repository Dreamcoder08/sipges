import { readFile } from 'node:fs/promises';
import { CanonicalEntities, ProjectCoordinates } from '@mascli/contracts';
import type { ReferenceReader } from '../application/index.ts';
const registered = (scope: { companyId: string; projectId: string }) =>
  scope.companyId === 'MASCLI' && scope.projectId === 'PRJ-SECHURA';
/** Trusted repository references are registered to one tenant, never used as a fallback. */
export const fileReferenceReader: ReferenceReader = {
  coordinates: async (scope) =>
    registered(scope)
      ? ProjectCoordinates.parse(
          JSON.parse(
            await readFile(
              new URL('../../../../../../data/project_coordinates.json', import.meta.url),
              'utf8',
            ),
          ),
        )
      : null,
  entities: async (scope) =>
    registered(scope)
      ? CanonicalEntities.parse(
          JSON.parse(
            await readFile(
              new URL('../../../../../../data/canonical_entities.json', import.meta.url),
              'utf8',
            ),
          ),
        )
      : null,
};
