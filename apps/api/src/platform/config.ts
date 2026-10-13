export type AppConfig = {
  readonly cookieSecure: boolean;
  readonly host: string;
  readonly port: number;
  /** AES-256-GCM key for secrets at rest (TOTP), docs/adr/0004. */
  readonly dataKey: Buffer;
  readonly admin: {
    readonly username: string;
    readonly password: string;
    readonly fullName: string;
  };
  /** PostgreSQL URL; when absent the API uses embedded PGlite at `pgliteDir`. */
  readonly databaseUrl: string | undefined;
  readonly pgliteDir: string;
  /** Read X-Forwarded-For from a trusted reverse proxy (MASCLI_TRUST_PROXY=1). */
  readonly trustProxy: boolean;
};

type Env = Readonly<Record<string, string | undefined>>;

/** Strict boolean switch: unset or exactly '0' / '1' (parity with app.py:10-18 for cookies). */
const parseSwitch = (name: string, value: string | undefined, fallback: boolean): boolean => {
  if (value === undefined) return fallback;
  if (value !== '0' && value !== '1')
    throw new Error(`${name} must be unset or exactly '0' or '1'`);
  return value === '1';
};

const parseDatabaseUrl = (env: Env): string | undefined => {
  const url = env.MASCLI_DATABASE_URL || undefined;
  if (!url && env.NODE_ENV === 'production') {
    throw new Error('MASCLI_DATABASE_URL is required when NODE_ENV=production');
  }
  return url;
};

const parsePort = (value: string | undefined): number => {
  if (value === undefined) return 8000;
  const port = /^\d+$/.test(value) ? Number(value) : Number.NaN;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('MASCLI_PORT must be an integer between 1 and 65535');
  }
  return port;
};

const parseDataKey = (value: string | undefined): Buffer => {
  if (value === undefined) throw new Error('MASCLI_DATA_KEY is required (base64, 32 bytes)');
  const key = /^[A-Za-z0-9+/]+={0,2}$/.test(value) ? Buffer.from(value, 'base64') : Buffer.alloc(0);
  if (key.length !== 32) throw new Error('MASCLI_DATA_KEY must decode to 32 bytes');
  return key;
};

/** Validates the whole environment once, before any resource is created. */
export const loadConfig = (env: Env): AppConfig => ({
  cookieSecure: parseSwitch('MASCLI_COOKIE_SECURE', env.MASCLI_COOKIE_SECURE, true),
  host: env.MASCLI_HOST ?? '127.0.0.1',
  port: parsePort(env.MASCLI_PORT),
  dataKey: parseDataKey(env.MASCLI_DATA_KEY),
  admin: {
    username: (env.MASCLI_ADMIN_USERNAME ?? 'admin').trim().toLowerCase(),
    password: env.MASCLI_ADMIN_PASSWORD ?? '',
    fullName: env.MASCLI_ADMIN_FULL_NAME?.trim() || 'Administrator',
  },
  databaseUrl: parseDatabaseUrl(env),
  pgliteDir: env.MASCLI_PGLITE_DIR ?? '.data/pglite',
  trustProxy: parseSwitch('MASCLI_TRUST_PROXY', env.MASCLI_TRUST_PROXY, false),
});
