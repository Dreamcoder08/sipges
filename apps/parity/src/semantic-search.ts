import postgres from 'postgres';
import { EMBEDDER_DOWN } from './embedder-double.ts';
import { REQUEST_TIMEOUT_MS, send } from './request.ts';
import type { ParityCase } from './types.ts';

/**
 * Hybrid search (T51). It runs after the other cases, against both APIs restarted with
 * SIPGES_SEMANTIC_SEARCH on. A search embeds records as it goes, so two APIs searching at once
 * would race for the index: each API first indexes the project on its own, the two indexes are
 * compared, and only then do the cases, all reads, go to both.
 */
const TENANT = 'SIPGES/PRJ-SECHURA';
const SEARCH = '/system/search';

const search = (name: string, query: string, auth: 'admin' | 'consulta' = 'admin'): ParityCase => ({
  name: `semantic search ${name}`,
  method: 'GET',
  path: `${SEARCH}?${query}`,
  auth,
});

export const semanticSearchCases: readonly ParityCase[] = [
  search('one word', 'q=agua'),
  search('a phrase', 'q=reuni%C3%B3n%20sobre%20el%20agua%20y%20la%20tierra'),
  search('a word no record holds', 'q=zzzz'),
  search('a record id', 'q=PARITY-INT-A'),
  search('of one module', 'q=agua&modules=eventos'),
  search('of two modules', 'q=agua&modules=eventos,alertas'),
  search('of an unknown module', 'q=agua&modules=nada'),
  search('limited', 'q=agua&limit=2'),
  search('limited to one', 'q=agua&limit=1'),
  search('above the maximum', 'q=agua&limit=999'),
  search('empty', 'q='),
  search('only symbols', 'q=%21%21%21'),
  search('with spaces around it', 'q=%20%20agua%20%20'),
  search('with the embedder down', `q=agua%20${EMBEDDER_DOWN}`),
  search('by the read-only role', 'q=agua', 'consulta'),
  { name: 'semantic search without a session', method: 'GET', path: `${SEARCH}?q=agua` },
];

const STORED = `SELECT count(*)::int AS rows, md5(coalesce(string_agg(
    module || '/' || id || '/' || model || '/' || vector::text || '/' || source_hash, ','
    ORDER BY module, id), '')) AS digest
  FROM record_embeddings WHERE tenant_id = '${TENANT}'`;

type Index = { readonly rows: number; readonly digest: string };

const MAX_SEARCHES = 200;

/** Searches until a search embeds nothing new, then reads what is stored. */
const indexThrough = async (
  sql: postgres.Sql,
  url: string,
  session: string,
  api: 'ts' | 'go',
): Promise<Index> => {
  const warm = search('warm-up', 'q=agua');
  let last = -1;
  for (let i = 0; i < MAX_SEARCHES; i++) {
    await send(url, warm, session, REQUEST_TIMEOUT_MS, api);
    const [now] = await sql.unsafe<Index[]>(STORED);
    if (!now) throw new Error('the index query returned no row');
    if (now.rows === last) return now;
    last = now.rows;
  }
  throw new Error(`the ${api} API did not finish indexing`);
};

/** Each API indexes the project from nothing; both must store the same vectors and hashes. */
export const compareIndexes = async (
  databaseUrl: string,
  session: string,
  urls: { readonly ts: string; readonly go: string },
) => {
  const sql = postgres(databaseUrl, { max: 1, onnotice: () => undefined });
  try {
    const ts = await indexThrough(sql, urls.ts, session, 'ts');
    await sql.unsafe(`DELETE FROM record_embeddings WHERE tenant_id = '${TENANT}'`);
    const go = await indexThrough(sql, urls.go, session, 'go');
    return { ts, go, same: ts.rows > 0 && ts.rows === go.rows && ts.digest === go.digest };
  } finally {
    await sql.end();
  }
};
