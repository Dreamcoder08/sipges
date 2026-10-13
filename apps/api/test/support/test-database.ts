import type { PGliteInterface } from '@electric-sql/pglite';
import { afterEach } from 'vitest';

const databases = new Set<PGliteInterface>();

/** Register immediately after allocation, before setup that could reject. */
export const trackTestDatabase = <T extends PGliteInterface>(db: T): T => {
  databases.add(db);
  return db;
};

// Tests within a file must remain sequential: these resources are per-test owners.
afterEach(async () => {
  for (const db of databases) {
    try {
      if (!db.closed) await db.close();
    } finally {
      databases.delete(db);
    }
  }
});
