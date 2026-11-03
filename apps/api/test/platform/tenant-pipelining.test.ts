import { describe, expect, it } from 'vitest';
import type { SqlClient } from '../../src/platform/database/sql-client.ts';
import { withTenant } from '../../src/platform/database/tenant-transaction.ts';

/** A transaction whose tenant statement stays unanswered until released. */
const held = () => {
  const order: string[] = [];
  let answer!: (error?: Error) => void;
  const entered = new Promise<void>((resolve, reject) => {
    answer = (error) => (error ? reject(error) : resolve());
  });
  const tx: SqlClient = {
    exec: async () => {
      order.push('enter');
      await entered;
    },
    query: async <Row>() => {
      order.push('query');
      return [] as Row[];
    },
    transaction: (fn) => fn(tx),
  };
  return { sql: tx, order, answer };
};

describe('withTenant on a remote database', () => {
  it('sends the first query right behind the tenant settings without waiting for them', async () => {
    // Statements on one connection run in order, so the query still runs under the tenant
    // settings; not waiting for their answer saves a round trip on every tenant request.
    const t = held();
    let ran = false;
    const work = withTenant(t.sql, 'ACME/NORTE', async (tx) => {
      await tx.query('SELECT 1');
      ran = true;
      return 'done';
    });
    await new Promise((r) => setImmediate(r));
    expect(t.order).toEqual(['enter', 'query']);
    expect(ran).toBe(true);
    t.answer();
    expect(await work).toBe('done');
  });

  it('reports a failure to enter the tenant, not the work that followed it', async () => {
    const t = held();
    const work = withTenant(t.sql, 'ACME/NORTE', async (tx) => {
      await tx.query('SELECT 1');
      return 'done';
    });
    t.answer(new Error('could not enter tenant'));
    await expect(work).rejects.toThrow('could not enter tenant');
  });

  it('runs no work at all for an invalid tenant id', async () => {
    const t = held();
    let called = false;
    const work = withTenant(t.sql, 'ACME\0NORTE', async () => {
      called = true;
      return 'done';
    });
    await expect(work).rejects.toThrow('Tenant settings cannot contain NUL characters');
    expect(called).toBe(false);
    expect(t.order).toEqual([]);
  });

  it('does not settle before the work finishes when entering fails', async () => {
    const t = held();
    const steps: string[] = [];
    let finishWork!: () => void;
    const work = withTenant(t.sql, 'ACME/NORTE', async (tx) => {
      await tx.query('SELECT 1').catch(() => undefined);
      await new Promise<void>((r) => (finishWork = r));
      steps.push('work done');
      return 'done';
    });
    const settled = work.then(
      () => steps.push('settled'),
      () => steps.push('settled'),
    );
    t.answer(new Error('could not enter tenant'));
    await new Promise((r) => setImmediate(r));
    expect(steps).toEqual([]);
    finishWork();
    await settled;
    expect(steps).toEqual(['work done', 'settled']);
    await expect(work).rejects.toThrow('could not enter tenant');
  });

  it('reports the failure to enter even when the work failed first', async () => {
    const t = held();
    const work = withTenant(t.sql, 'ACME/NORTE', async () => {
      throw new Error('work failed');
    });
    await new Promise((r) => setImmediate(r));
    t.answer(new Error('could not enter tenant'));
    await expect(work).rejects.toThrow('could not enter tenant');
  });

  it('still waits for the tenant statement when the work throws synchronously', async () => {
    const t = held();
    const work = withTenant(t.sql, 'ACME/NORTE', (() => {
      throw new Error('sync failure');
    }) as unknown as () => Promise<string>);
    t.answer(new Error('could not enter tenant'));
    await expect(work).rejects.toThrow('could not enter tenant');
  });
});
