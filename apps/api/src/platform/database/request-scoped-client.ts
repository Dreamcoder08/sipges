import { AsyncLocalStorage } from 'node:async_hooks';
import type { SqlClient } from './sql-client.ts';

const UNBOUND = 'No SQL connection is bound to this request';

/**
 * A SqlClient that delegates to the connection bound to the current request. Cloudflare
 * Workers forbid reusing an I/O object across requests, so the container is built once per
 * isolate around this client and each request runs inside `run` with its own connection.
 * A call outside `run` fails instead of falling back to a shared connection.
 */
export const requestScopedSqlClient = () => {
  const current = new AsyncLocalStorage<SqlClient>();
  const bound = () => {
    const client = current.getStore();
    if (!client) throw new Error(UNBOUND);
    return client;
  };
  const client: SqlClient = {
    query: async (text, params) => bound().query(text, params),
    exec: async (text) => bound().exec(text),
    transaction: async (fn) => bound().transaction(fn),
  };
  return {
    client,
    run: <T>(connection: SqlClient, fn: () => T): T => current.run(connection, fn),
  };
};
