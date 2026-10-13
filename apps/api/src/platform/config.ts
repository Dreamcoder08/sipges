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
};

type Env = Readonly<Record<string, string | undefined>>;

/** Parity with app.py:10-18: unset or "1" -> Secure, "0" -> not Secure, anything else fails. */
const parseCookieSecure = (value: string | undefined): boolean => {
  if (value !== undefined && value !== '0' && value !== '1') {
    throw new Error("MASCLI_COOKIE_SECURE must be unset or exactly '0' or '1'");
  }
  return value !== '0';
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
  cookieSecure: parseCookieSecure(env.MASCLI_COOKIE_SECURE),
  host: env.MASCLI_HOST ?? '127.0.0.1',
  port: parsePort(env.MASCLI_PORT),
  dataKey: parseDataKey(env.MASCLI_DATA_KEY),
  admin: {
    username: (env.MASCLI_ADMIN_USERNAME ?? 'admin').trim().toLowerCase(),
    password: env.MASCLI_ADMIN_PASSWORD ?? '',
    fullName: env.MASCLI_ADMIN_FULL_NAME?.trim() || 'Administrator',
  },
  databaseUrl: env.MASCLI_DATABASE_URL || undefined,
  pgliteDir: env.MASCLI_PGLITE_DIR ?? '.data/pglite',
});
