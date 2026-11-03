import { describe, expect, it } from 'vitest';
import type { TenancyStore, TenantSummary } from '../../src/contexts/tenancy/application/ports.ts';
import { createGrantCache } from '../../src/contexts/tenancy/application/grant-cache.ts';
import { createTenancyService } from '../../src/contexts/tenancy/application/tenancy-service.ts';

const ADMIN = { username: 'admin', role: 'admin' };
const NORTE = { companyId: 'ACME', projectId: 'NORTE' };
const SUR = { companyId: 'ACME', projectId: 'SUR' };

const setup = () => {
  const grants = new Map<string, TenantSummary[]>([
    [
      'analista',
      [
        { ...NORTE, label: 'Norte' },
        { ...SUR, label: 'Sur' },
      ],
    ],
  ]);
  let lookups = 0;
  let hold: Promise<void> | undefined;
  let failRevoke = false;
  const store: TenancyStore = {
    ensureTenant: async () => undefined,
    createTenantWithGrant: async (scope, label, username) => {
      grants.set(username, [...(grants.get(username) ?? []), { ...scope, label }]);
      return true;
    },
    tenantExists: async () => true,
    tenantLabel: async () => 'Norte',
    grant: async (username, scope) => {
      grants.set(username, [...(grants.get(username) ?? []), { ...scope, label: 'Nuevo' }]);
    },
    revoke: async (username, scope) => {
      grants.set(
        username,
        (grants.get(username) ?? []).filter((g) => g.projectId !== scope.projectId),
      );
      if (failRevoke) {
        failRevoke = false;
        throw new Error('connection lost after commit');
      }
      return true;
    },
    listGrants: async (username) => {
      lookups += 1;
      const snapshot = [...(grants.get(username) ?? [])];
      if (hold) await hold;
      return snapshot;
    },
  };
  let now = new Date('2026-11-02T12:00:00Z');
  const service = createTenancyService({
    store,
    users: { exists: async () => true, adminUsernames: async () => [] },
    clock: { now: () => now },
    dataReader: { read: async () => ({}) as never },
  });
  const resolve = (scope: string) =>
    service.resolve({ username: 'analista', header: scope, cookie: undefined });
  return {
    service,
    resolve,
    lookups: () => lookups,
    failNextRevokeAfterCommit: () => {
      failRevoke = true;
    },
    advance: (seconds: number) => (now = new Date(now.getTime() + seconds * 1000)),
    holdNextLookups: () => {
      let release!: () => void;
      hold = new Promise((r) => (release = r));
      return () => {
        hold = undefined;
        release();
      };
    },
  };
};

describe('grant lookups on the request path', () => {
  it('reuses a user grants for 30 s instead of querying on every request', async () => {
    // Every authenticated request resolves its project from the user's grants.
    const t = setup();
    expect((await t.resolve('ACME/NORTE')).ok).toBe(true);
    t.advance(29);
    expect((await t.resolve('ACME/SUR')).ok).toBe(true);
    expect(t.lookups()).toBe(1);
    t.advance(2);
    await t.resolve('ACME/NORTE');
    expect(t.lookups()).toBe(2);
  });

  it('stops resolving a revoked project at once', async () => {
    const t = setup();
    await t.resolve('ACME/SUR');
    expect((await t.service.revoke(ADMIN, { ...SUR, username: 'analista' })).ok).toBe(true);
    expect(await t.resolve('ACME/SUR')).toEqual({ ok: false, projects: ['ACME/NORTE'] });
  });

  it('resolves a newly granted or created project at once', async () => {
    const t = setup();
    await t.resolve('ACME/NORTE');
    await t.service.grant(ADMIN, { companyId: 'ACME', projectId: 'ESTE', username: 'analista' });
    expect((await t.resolve('ACME/ESTE')).ok).toBe(true);
    await t.service.createTenant(ADMIN, {
      companyId: 'ACME',
      projectId: 'OESTE',
      label: 'Oeste',
      username: 'analista',
    });
    expect((await t.resolve('ACME/OESTE')).ok).toBe(true);
  });

  it('does not cache grants read before a revoke that finished first', async () => {
    const t = setup();
    const release = t.holdNextLookups();
    const slow = t.resolve('ACME/SUR');
    await new Promise((r) => setImmediate(r));
    await t.service.revoke(ADMIN, { ...SUR, username: 'analista' });
    release();
    await slow;
    expect(await t.resolve('ACME/SUR')).toEqual({ ok: false, projects: ['ACME/NORTE'] });
  });

  it('keeps export authorization on fresh grants', async () => {
    const t = setup();
    await t.resolve('ACME/NORTE');
    await t.service.exportData(ADMIN, NORTE);
    await t.service.isGranted('analista', 'ACME/NORTE');
    expect(t.lookups()).toBe(3);
  });

  it('queries again exactly when the copy is 30 s old', async () => {
    const t = setup();
    await t.resolve('ACME/NORTE');
    t.advance(30);
    await t.resolve('ACME/NORTE');
    expect(t.lookups()).toBe(2);
  });

  it('forgets a revoke even when the store fails after committing it', async () => {
    const t = setup();
    await t.resolve('ACME/SUR');
    t.failNextRevokeAfterCommit();
    await expect(t.service.revoke(ADMIN, { ...SUR, username: 'analista' })).rejects.toThrow();
    expect(await t.resolve('ACME/SUR')).toEqual({ ok: false, projects: ['ACME/NORTE'] });
  });
});

describe('grant cache bounds', () => {
  it('keeps at most 1000 users, dropping the oldest', async () => {
    let lookups = 0;
    const cache = createGrantCache(
      async () => {
        lookups += 1;
        return [];
      },
      { now: () => new Date('2026-11-02T12:00:00Z') },
    );
    for (let i = 0; i <= 1000; i++) await cache.get(`u${i}`);
    expect(lookups).toBe(1001);
    await cache.get('u1000');
    await cache.get('u1');
    expect(lookups).toBe(1001);
    await cache.get('u0');
    expect(lookups).toBe(1002);
  });
});
