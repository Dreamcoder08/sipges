import type { Context } from 'hono';
import type { Identity } from '../../contexts/identity/application/index.ts';
import type { Scope } from '../../contexts/tenancy/application/index.ts';

/** Request-scoped values set by middleware (undefined on public routes). */
export type AppEnv = {
  Variables: {
    identity: Identity;
    sessionToken: string;
    scope: Scope;
    automationTenant: string | undefined;
  };
};

/** Resolves the client address used for throttling (proxy-aware in main.ts). */
export type ClientIp = (c: Context) => string;
