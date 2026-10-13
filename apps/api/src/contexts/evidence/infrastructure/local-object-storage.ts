import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import type { ObjectStorage } from '../application/ports.ts';

/** Keys are `<prefix>/<name>` made of safe characters only; anything else is a bug. */
const KEY_PATTERN = /^[0-9a-f]{24}\/[A-Za-z0-9._-]+$/;

/**
 * Stores objects as files under `root` (development, single-server installs on a persistent
 * disk). Writes go to a temporary file first and are renamed into place, so a crash never
 * leaves a truncated object under the final key.
 */
export const createLocalObjectStorage = (root: string): ObjectStorage => {
  const base = resolve(root);
  const pathFor = (key: string) => {
    if (!KEY_PATTERN.test(key)) throw new Error(`Invalid object key: ${key}`);
    const path = resolve(join(base, key));
    if (!path.startsWith(base + sep)) throw new Error(`Object key escapes storage root: ${key}`);
    return path;
  };

  return {
    async put(key, bytes) {
      const path = pathFor(key);
      await mkdir(dirname(path), { recursive: true });
      const temporary = `${path}.${randomBytes(6).toString('hex')}.tmp`;
      await writeFile(temporary, bytes, { flag: 'wx' });
      await rename(temporary, path);
    },

    async get(key) {
      try {
        return new Uint8Array(await readFile(pathFor(key)));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw error;
      }
    },

    async delete(key) {
      await rm(pathFor(key), { force: true });
    },
  };
};
