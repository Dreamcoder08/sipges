import { readFile } from 'node:fs/promises';
import { CanonicalEntities, ProjectCoordinates } from '@mascli/contracts';
import type { ReferenceReader } from '../application/index.ts';
import { isRegisteredReferenceScope as registered } from './static-reference-reader.ts';
/** Reads the repository references from disk (Node); Workers use the static reader. */
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
