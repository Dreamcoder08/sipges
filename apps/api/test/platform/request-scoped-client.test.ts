import { describe, expect, it } from 'vitest';
import type { SqlClient } from '../../src/platform/database/sql-client.ts';
import { requestScopedSqlClient } from '../../src/platform/database/request-scoped-client.ts';

/** A fake client that records which connection each call reached. */
const recording = (name: string, calls: string[]): SqlClient => {
  const client: SqlClient = {
    query: async <Row>(text: string) => {
      calls.push(`${name}:${text}`);
      return [{ connection: name }] as Row[];
    },
    exec: async (text) => {
      calls.push(`${name}:exec:${text}`);
    },
    transaction: (fn) => fn(client),
  };
  return client;
};

const tick = () => new Promise((resolve) => setTimeout(resolve, 1));

describe('requestScopedSqlClient', () => {
  it('routes every call to the client bound to the current request', async () => {
    const calls: string[] = [];
    const scoped = requestScopedSqlClient();
    const result = await scoped.run(recording('a', calls), async () => {
      await scoped.client.exec('SET x');
      await scoped.client.transaction((tx) => tx.query('SELECT 1'));
      return scoped.client.query('SELECT 2');
    });
    expect(result).toEqual([{ connection: 'a' }]);
    expect(calls).toEqual(['a:exec:SET x', 'a:SELECT 1', 'a:SELECT 2']);
  });

  it('keeps concurrent requests on their own connections across awaits', async () => {
    const calls: string[] = [];
    const scoped = requestScopedSqlClient();
    const request = (name: string) =>
      scoped.run(recording(name, calls), async () => {
        await tick();
        await scoped.client.query(`one ${name}`);
        await tick();
        await scoped.client.query(`two ${name}`);
      });
    await Promise.all([request('a'), request('b'), request('c')]);
    for (const name of ['a', 'b', 'c']) {
      expect(calls.filter((call) => call.startsWith(`${name}:`))).toEqual([
        `${name}:one ${name}`,
        `${name}:two ${name}`,
      ]);
    }
    expect(calls).toHaveLength(6);
  });

  it('refuses a call outside any request instead of sharing a connection', async () => {
    const scoped = requestScopedSqlClient();
    await expect(scoped.client.query('SELECT 1')).rejects.toThrow(
      'No SQL connection is bound to this request',
    );
    await expect(scoped.client.exec('SELECT 1')).rejects.toThrow(
      'No SQL connection is bound to this request',
    );
    await expect(scoped.client.transaction(async () => 1)).rejects.toThrow(
      'No SQL connection is bound to this request',
    );
  });
});
