import { constants } from 'node:fs';
import { lstat, open, readFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, parse } from 'node:path';
import { CanonicalEntities, ProjectCoordinates } from '@sipges/contracts';
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

/** Managed files are fixed names beneath an explicit directory, never repository fallbacks. */
export const createManagedReferenceReader = (dir: string): ReferenceReader => {
  if (!isAbsolute(dir)) throw new Error('SIPGES_REFERENCE_DIR must be an absolute path');
  const read = async (name: string): Promise<string | null> => {
    try {
      // Reject symlinks in every component, including the configured directory itself.
      const parts: string[] = [];
      for (let path = dir; path !== dirname(path); path = dirname(path)) parts.unshift(path);
      for (const path of [parse(dir).root, ...parts]) {
        const info = await lstat(path);
        if (info.isSymbolicLink() || !info.isDirectory())
          throw new Error('Unsafe reference directory');
      }
      const path = join(dir, name);
      const info = await lstat(path);
      if (info.isSymbolicLink() || !info.isFile()) throw new Error('Unsafe reference file');
      // O_NOFOLLOW is unavailable on Windows; lstat and fstat still reject normal links there.
      const handle = await open(
        path,
        constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
      );
      try {
        if (!(await handle.stat()).isFile()) throw new Error('Unsafe reference file');
        return await handle.readFile('utf8');
      } finally {
        await handle.close();
      }
    } catch (error) {
      if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT')
        return null;
      throw error;
    }
  };
  return {
    coordinates: async (scope) => {
      if (!registered(scope)) return null;
      const raw = await read('project_coordinates.json');
      return raw === null ? null : ProjectCoordinates.parse(JSON.parse(raw));
    },
    entities: async (scope) => {
      if (!registered(scope)) return null;
      const raw = await read('canonical_entities.json');
      return raw === null ? null : CanonicalEntities.parse(JSON.parse(raw));
    },
  };
};
