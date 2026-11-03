import { type Result, err, ok } from '@sipges/kernel';
import {
  DEFAULT_SCOPE,
  DEFAULT_SCOPE_LABEL,
  type NewTenant,
  type Scope,
  formatScope,
  resolveScope,
  validateNewTenant,
} from '../domain/scope.ts';
import type {
  Clock,
  TenantDataReader,
  TenancyStore,
  TenantSummary,
  UserDirectory,
} from './ports.ts';
import { createGrantCache } from './grant-cache.ts';

export type Actor = { readonly username: string; readonly role: string };

export type ScopeResolution =
  | { readonly ok: true; readonly scope: Scope }
  | { readonly ok: false; readonly projects: string[] };

export type CreateTenantError =
  'forbidden' | 'invalid_ids' | 'reserved' | 'user_missing' | 'exists';
export type GrantError = 'forbidden' | 'user_missing' | 'tenant_missing';

export const createTenancyService = (deps: {
  store: TenancyStore;
  users: UserDirectory;
  clock: Clock;
  dataReader: TenantDataReader;
}) => {
  const { store, users, clock } = deps;
  // Only the per-request project resolution reads cached grants; authorization checks such as
  // export and isGranted keep reading them fresh.
  const requestGrants = createGrantCache((username) => store.listGrants(username), clock);

  return {
    /** Ensures the legacy default project exists and every admin can reach it (app.py bootstrap). */
    async bootstrap(): Promise<void> {
      const at = clock.now();
      await store.ensureTenant(DEFAULT_SCOPE, DEFAULT_SCOPE_LABEL, at);
      for (const admin of await users.adminUsernames()) await store.grant(admin, DEFAULT_SCOPE, at);
    },

    /** The project's display label, for other contexts that name the active project. */
    label: (scope: Scope) => store.tenantLabel(scope),

    async exportData(actor: Actor, scope: Scope) {
      if (
        actor.role !== 'admin' ||
        !(await store.listGrants(actor.username)).some((g) => formatScope(g) === formatScope(scope))
      )
        return err('forbidden' as const);
      const data = await deps.dataReader.read(scope);
      return ok({
        format: 'sipges.tenant-export' as const,
        version: 1 as const,
        scope: { company_id: scope.companyId, project_id: scope.projectId },
        exported_at: `${clock.now().toISOString().slice(0, 19)}Z`,
        data,
      });
    },

    listGranted(username: string): Promise<TenantSummary[]> {
      return store.listGrants(username);
    },

    async resolve(input: {
      username: string;
      header: string | undefined;
      cookie: string | undefined;
    }): Promise<ScopeResolution> {
      const grants = await requestGrants.get(input.username);
      const scope = resolveScope({ header: input.header, cookie: input.cookie, grants });
      return scope ? { ok: true, scope } : { ok: false, projects: grants.map(formatScope) };
    },

    async isGranted(username: string, scopeText: string): Promise<boolean> {
      return (await store.listGrants(username)).some((g) => formatScope(g) === scopeText);
    },

    async createTenant(actor: Actor, input: NewTenant): Promise<Result<string, CreateTenantError>> {
      if (actor.role !== 'admin') return err('forbidden');
      const valid = validateNewTenant(input);
      if (!valid.ok) return err(valid.error);
      if (!(await users.exists(valid.value.username))) return err('user_missing');
      // Forget even when the write fails after committing: a stale copy must not outlive it.
      try {
        const created = await store.createTenantWithGrant(
          valid.value,
          valid.value.label,
          valid.value.username,
          clock.now(),
        );
        return created ? ok(formatScope(valid.value)) : err('exists');
      } finally {
        requestGrants.forget(valid.value.username);
      }
    },

    async revoke(
      actor: Actor,
      input: Scope & { username: string },
    ): Promise<Result<true, GrantError | 'grant_missing'>> {
      if (actor.role !== 'admin') return err('forbidden');
      if (!(await users.exists(input.username))) return err('user_missing');
      if (!(await store.tenantExists(input))) return err('tenant_missing');
      try {
        return (await store.revoke(input.username, input)) ? ok(true) : err('grant_missing');
      } finally {
        requestGrants.forget(input.username);
      }
    },

    async grant(
      actor: Actor,
      input: Scope & { username: string },
    ): Promise<Result<true, GrantError>> {
      if (actor.role !== 'admin') return err('forbidden');
      if (!(await users.exists(input.username))) return err('user_missing');
      if (!(await store.tenantExists(input))) return err('tenant_missing');
      try {
        await store.grant(input.username, input, clock.now());
        return ok(true);
      } finally {
        requestGrants.forget(input.username);
      }
    },
  };
};

export type TenancyService = ReturnType<typeof createTenancyService>;
