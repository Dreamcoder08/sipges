/**
 * Synthetic rows both APIs read during a parity run. seed.ts creates the users and their grants
 * through the TypeScript API; these fixtures add, straight in the database, a project nobody in
 * the run is granted (OTHER_TENANT) and each context's rows (`seed` in contexts/*.ts) in it and
 * in the default project, so a case can prove another project's rows stay invisible.
 *
 * Only synthetic values: no real names, places or records.
 */
import postgres from 'postgres';
import { SEEDS } from './contexts/index.ts';

/** A project nobody in the run is granted; its rows must never appear in an answer. */
export const OTHER_TENANT = 'PARITY/OTRO';

const BASE = `INSERT INTO tenants (company_id, project_id, label)
  VALUES ('PARITY', 'OTRO', 'Proyecto sintético ajeno');`;

/**
 * Loads the fixtures into the database at `databaseUrl` as the synthetic server's superuser, so
 * row-level security does not apply, after the TypeScript API applied the migrations and created
 * the default project.
 */
export const seedDatabase = async (databaseUrl: string) => {
  const sql = postgres(databaseUrl, { max: 1, onnotice: () => undefined });
  try {
    await sql.begin(async (tx) => {
      await tx.unsafe(BASE);
      for (const seed of SEEDS) await tx.unsafe(seed);
    });
  } finally {
    await sql.end();
  }
};
