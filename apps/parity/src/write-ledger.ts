/**
 * Records which API wrote which table, so a run can tell a write that landed from a 200 that
 * touched nothing. Each API connects under its own application_name; a trigger on every table
 * notes it. Installed by the server's superuser after the migrations, in the scratch database
 * only, and it runs as that superuser, so it sees through RLS while the APIs do not.
 */
import postgres from 'postgres';
import type { LedgerRow } from './write-proof.ts';

export const API_NAMES = { ts: 'sipges-parity-ts', go: 'sipges-parity-go' } as const;

export const withApplicationName = (url: string, api: keyof typeof API_NAMES) => {
  const parsed = new URL(url);
  parsed.searchParams.set('application_name', API_NAMES[api]);
  return parsed.toString();
};

const INSTALL = `
CREATE TABLE parity_write_ledger (
  id bigserial PRIMARY KEY, api text NOT NULL, tbl text NOT NULL
);
CREATE FUNCTION parity_write_ledger_note() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  INSERT INTO parity_write_ledger (api, tbl)
  VALUES (current_setting('application_name'), TG_TABLE_NAME);
  RETURN NULL;
END;
$$;
DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT c.oid::regclass AS rel FROM pg_class c
    WHERE c.relnamespace = 'public'::regnamespace AND c.relkind = 'r'
      AND c.relname NOT IN ('parity_write_ledger', 'schema_migrations')
  LOOP
    EXECUTE format(
      'CREATE TRIGGER parity_write_ledger AFTER INSERT OR UPDATE OR DELETE ON %s
         FOR EACH ROW EXECUTE FUNCTION parity_write_ledger_note()', r.rel);
  END LOOP;
END;
$$;`;

export type Ledger = {
  /** The rows written since the last call. */
  readonly drain: () => Promise<LedgerRow[]>;
  readonly close: () => Promise<void>;
};

export const openLedger = async (adminUrl: string): Promise<Ledger> => {
  const sql = postgres(adminUrl, { max: 1, onnotice: () => undefined });
  await sql.unsafe(INSTALL);
  const apiOf = new Map<string, LedgerRow['api']>([
    [API_NAMES.ts, 'ts'],
    [API_NAMES.go, 'go'],
  ]);
  let seen = 0;
  return {
    drain: async () => {
      const rows = await sql<{ id: string; api: string; tbl: string }[]>`
        SELECT id, api, tbl FROM parity_write_ledger WHERE id > ${seen} ORDER BY id`;
      seen = Number(rows.at(-1)?.id ?? seen);
      return rows.flatMap(({ api, tbl }) => {
        const known = apiOf.get(api);
        return known ? [{ api: known, table: tbl }] : [];
      });
    },
    close: () => sql.end(),
  };
};
