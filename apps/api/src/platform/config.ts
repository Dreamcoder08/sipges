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
  /** Largest accepted evidence file (MASCLI_MAX_UPLOAD_BYTES, docs/adr/0008 #9). */
  readonly maxUploadBytes: number;
  /** Where evidence file bytes live (docs/migration/evidence.md). */
  readonly storage: StorageConfig;
  /** Local embedding service for semantic text analysis (docs/migration/operations.md). */
  readonly ollama: { readonly baseUrl: string; readonly model: string };
  /** Built web app to serve (MASCLI_WEB_DIR, e.g. apps/web/dist); unset serves the API only. */
  readonly webDir: string | undefined;
};

export type StorageConfig =
  | { readonly kind: 'local'; readonly dir: string }
  | {
      readonly kind: 's3';
      readonly endpoint: string;
      readonly region: string;
      readonly bucket: string;
      readonly accessKeyId: string;
      readonly secretAccessKey: string;
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

const MAX_UPLOAD_CEILING = 100 * 1024 * 1024;

const parseMaxUpload = (value: string | undefined): number => {
  if (value === undefined) return 10 * 1024 * 1024;
  const bytes = /^\d+$/.test(value) ? Number(value) : Number.NaN;
  if (!Number.isSafeInteger(bytes) || bytes < 1 || bytes > MAX_UPLOAD_CEILING) {
    throw new Error(
      `MASCLI_MAX_UPLOAD_BYTES must be an integer between 1 and ${MAX_UPLOAD_CEILING}`,
    );
  }
  return bytes;
};

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

const parseStorage = (env: Env): StorageConfig => {
  const kind = env.MASCLI_STORAGE ?? 'local';
  if (kind === 'local') return { kind, dir: env.MASCLI_UPLOAD_DIR ?? '.data/uploads' };
  if (kind !== 's3') throw new Error("MASCLI_STORAGE must be 'local' or 's3'");
  const required = (name: string) => {
    const value = env[name];
    if (!value) throw new Error(`${name} is required when MASCLI_STORAGE=s3`);
    return value;
  };
  const endpoint = required('MASCLI_S3_ENDPOINT');
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new Error('MASCLI_S3_ENDPOINT must be an absolute URL');
  }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && LOCAL_HOSTS.has(url.hostname))) {
    throw new Error('MASCLI_S3_ENDPOINT must use https (http only for a local test server)');
  }
  return {
    kind,
    endpoint,
    region: env.MASCLI_S3_REGION ?? 'auto',
    bucket: required('MASCLI_S3_BUCKET'),
    accessKeyId: required('MASCLI_S3_ACCESS_KEY_ID'),
    secretAccessKey: required('MASCLI_S3_SECRET_ACCESS_KEY'),
  };
};

const parseOllama = (env: Env) => {
  const baseUrl = env.MASCLI_OLLAMA_URL ?? 'http://127.0.0.1:11434';
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new Error('MASCLI_OLLAMA_URL must be an absolute URL');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:')
    throw new Error('MASCLI_OLLAMA_URL must use http or https');
  const model = env.MASCLI_OLLAMA_EMBED_MODEL || 'nomic-embed-text';
  return { baseUrl, model };
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
  maxUploadBytes: parseMaxUpload(env.MASCLI_MAX_UPLOAD_BYTES),
  storage: parseStorage(env),
  ollama: parseOllama(env),
  webDir: env.MASCLI_WEB_DIR || undefined,
});
