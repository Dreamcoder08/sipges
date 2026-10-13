import type { Context } from 'hono';
import type { Identity } from '../../contexts/identity/application/index.ts';

/** Request-scoped values set by middleware. */
export type AppEnv = {
  Variables: {
    identity: Identity;
    sessionToken: string;
  };
};

/** Resolves the client address used for throttling (proxy-aware in main.ts). */
export type ClientIp = (c: Context) => string;
