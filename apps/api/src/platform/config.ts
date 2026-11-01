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
  /** Read X-Forwarded-For from a trusted reverse proxy (SIPGES_TRUST_PROXY=1). */
  readonly trustProxy: boolean;
  readonly requireMfa: boolean;
  /** One JSON access-log line per request (SIPGES_ACCESS_LOG, default on). */
  readonly accessLog: boolean;
  readonly allowedHosts: readonly string[];
  /** Largest accepted evidence file (SIPGES_MAX_UPLOAD_BYTES, docs/adr/0008 #9). */
  readonly maxUploadBytes: number;
  /** Where evidence file bytes live (docs/migration/evidence.md). */
  readonly storage: StorageConfig;
  /** Local embedding service for semantic text analysis (docs/migration/operations.md). */
  readonly ollama: { readonly baseUrl: string; readonly model: string };
  /** Hybrid search with stored embeddings from the Ollama model (SIPGES_SEMANTIC_SEARCH=1). */
  readonly semanticSearch: boolean;
  /**
   * Language model that rewrites extractive briefings (docs/adr/0013). Off unless
   * SIPGES_ANALYST_PROVIDER=anthropic; the key comes from ANTHROPIC_API_KEY at the SDK.
   */
  readonly analyst: { readonly provider: 'anthropic'; readonly model: string } | undefined;
  /** Built web app to serve (SIPGES_WEB_DIR, e.g. apps/web/dist); unset serves the API only. */
  readonly webDir: string | undefined;
  /**
   * Automation engine (ADR 0014): in-process tick period in seconds (0 disables it) and the
   * bearer secret serverless cron jobs present to POST /system/automations/cron.
   */
  readonly automation: {
    readonly intervalSeconds: number;
    readonly cronSecret: string | undefined;
    /** Web Push keys (RFC 8292); unset disables device notifications. */
    readonly vapid:
      | { readonly publicKey: string; readonly privateKey: string; readonly subject: string }
      | undefined;
  };
  /**
   * OCR for scanned PDFs in the document lab (SIPGES_OCR=ocrmypdf); runs the local
   * ocrmypdf/Tesseract install with SIPGES_OCR_LANGUAGES. Unset keeps text-only reading.
   */
  readonly ocr: { readonly languages: string } | undefined;
  /** Google OAuth client for "Entrar con Google" (ADR 0010); unset hides the option. */
  readonly google:
    | {
        readonly clientId: string;
        readonly clientSecret: string;
        /** Links the bootstrap admin to this Google address on start (SIPGES_GOOGLE_ADMIN_EMAIL). */
        readonly adminEmail: string | undefined;
      }
    | undefined;
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
  const url = env.SIPGES_DATABASE_URL || undefined;
  if (!url && env.NODE_ENV === 'production') {
    throw new Error('SIPGES_DATABASE_URL is required when NODE_ENV=production');
  }
  return url;
};

const parsePort = (value: string | undefined): number => {
  if (value === undefined) return 8000;
  const port = /^\d+$/.test(value) ? Number(value) : Number.NaN;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('SIPGES_PORT must be an integer between 1 and 65535');
  }
  return port;
};

const parseDataKey = (value: string | undefined): Buffer => {
  if (value === undefined) throw new Error('SIPGES_DATA_KEY is required (base64, 32 bytes)');
  const key = /^[A-Za-z0-9+/]+={0,2}$/.test(value) ? Buffer.from(value, 'base64') : Buffer.alloc(0);
  if (key.length !== 32) throw new Error('SIPGES_DATA_KEY must decode to 32 bytes');
  return key;
};

const MAX_UPLOAD_CEILING = 100 * 1024 * 1024;

const parseMaxUpload = (value: string | undefined): number => {
  if (value === undefined) return 10 * 1024 * 1024;
  const bytes = /^\d+$/.test(value) ? Number(value) : Number.NaN;
  if (!Number.isSafeInteger(bytes) || bytes < 1 || bytes > MAX_UPLOAD_CEILING) {
    throw new Error(
      `SIPGES_MAX_UPLOAD_BYTES must be an integer between 1 and ${MAX_UPLOAD_CEILING}`,
    );
  }
  return bytes;
};

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

const parseStorage = (env: Env): StorageConfig => {
  const kind = env.SIPGES_STORAGE ?? 'local';
  if (kind === 'local') return { kind, dir: env.SIPGES_UPLOAD_DIR ?? '.data/uploads' };
  if (kind !== 's3') throw new Error("SIPGES_STORAGE must be 'local' or 's3'");
  const required = (name: string) => {
    const value = env[name];
    if (!value) throw new Error(`${name} is required when SIPGES_STORAGE=s3`);
    return value;
  };
  const endpoint = required('SIPGES_S3_ENDPOINT');
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new Error('SIPGES_S3_ENDPOINT must be an absolute URL');
  }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && LOCAL_HOSTS.has(url.hostname))) {
    throw new Error('SIPGES_S3_ENDPOINT must use https (http only for a local test server)');
  }
  return {
    kind,
    endpoint,
    region: env.SIPGES_S3_REGION ?? 'auto',
    bucket: required('SIPGES_S3_BUCKET'),
    accessKeyId: required('SIPGES_S3_ACCESS_KEY_ID'),
    secretAccessKey: required('SIPGES_S3_SECRET_ACCESS_KEY'),
  };
};

const parseOllama = (env: Env) => {
  const baseUrl = env.SIPGES_OLLAMA_URL ?? 'http://127.0.0.1:11434';
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new Error('SIPGES_OLLAMA_URL must be an absolute URL');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:')
    throw new Error('SIPGES_OLLAMA_URL must use http or https');
  const model = env.SIPGES_OLLAMA_EMBED_MODEL || 'nomic-embed-text';
  return { baseUrl, model };
};

const MODEL_ID = /^[a-z0-9][a-z0-9.-]{1,63}$/;

const parseAnalyst = (env: Env): AppConfig['analyst'] => {
  const provider = env.SIPGES_ANALYST_PROVIDER ?? '';
  if (provider === '' || provider === 'none') return undefined;
  if (provider !== 'anthropic')
    throw new Error("SIPGES_ANALYST_PROVIDER must be unset, 'none' or 'anthropic'");
  if (!env.ANTHROPIC_API_KEY && !env.ANTHROPIC_AUTH_TOKEN)
    throw new Error('SIPGES_ANALYST_PROVIDER=anthropic requires ANTHROPIC_API_KEY');
  const model = env.SIPGES_ANALYST_MODEL || 'claude-opus-5-5';
  if (!MODEL_ID.test(model)) throw new Error('SIPGES_ANALYST_MODEL is not a valid model id');
  return { provider, model };
};

const HOSTNAME =
  /^(?=.{1,253}$)[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/;

/** Comma-separated host names without port, e.g. `sipges.example.org,localhost`. */
export const parseAllowedHosts = (value: string | undefined): readonly string[] => {
  const hosts = (value ?? '')
    .split(',')
    .map((host) => host.trim().toLowerCase())
    .filter(Boolean);
  const invalid = hosts.find((host) => !HOSTNAME.test(host));
  if (invalid !== undefined) {
    throw new Error(`SIPGES_ALLOWED_HOSTS has an invalid host name: ${invalid}`);
  }
  return hosts;
};

const parseGoogle = (env: Env): AppConfig['google'] => {
  const clientId = env.SIPGES_GOOGLE_CLIENT_ID?.trim() ?? '';
  const clientSecret = env.SIPGES_GOOGLE_CLIENT_SECRET?.trim() ?? '';
  const adminEmail = env.SIPGES_GOOGLE_ADMIN_EMAIL?.trim() || undefined;
  if (!clientId && !clientSecret) {
    if (adminEmail) throw new Error('SIPGES_GOOGLE_ADMIN_EMAIL requires a Google OAuth client');
    return undefined;
  }
  if (!clientId || !clientSecret) {
    throw new Error('Set both SIPGES_GOOGLE_CLIENT_ID and SIPGES_GOOGLE_CLIENT_SECRET, or neither');
  }
  return { clientId, clientSecret, adminEmail };
};

const parseAutomation = (env: Env): AppConfig['automation'] => {
  const raw = env.SIPGES_AUTOMATION_INTERVAL;
  const interval = raw === undefined ? 30 : /^\d+$/.test(raw) ? Number(raw) : Number.NaN;
  if (!Number.isInteger(interval) || (interval !== 0 && (interval < 5 || interval > 3600))) {
    throw new Error('SIPGES_AUTOMATION_INTERVAL must be 0 (off) or between 5 and 3600 seconds');
  }
  // Schedulers send the secret as a bearer token; SIPGES_CRON_SECRET takes precedence over CRON_SECRET.
  const cronSecret = (env.SIPGES_CRON_SECRET || env.CRON_SECRET || '').trim() || undefined;
  if (cronSecret !== undefined && cronSecret.length < 24) {
    throw new Error('SIPGES_CRON_SECRET (or CRON_SECRET) must be at least 24 characters');
  }
  return { intervalSeconds: interval, cronSecret, vapid: parseVapid(env) };
};

const parseVapid = (env: Env): AppConfig['automation']['vapid'] => {
  const publicKey = env.SIPGES_VAPID_PUBLIC_KEY?.trim() ?? '';
  const privateKey = env.SIPGES_VAPID_PRIVATE_KEY?.trim() ?? '';
  const subject = env.SIPGES_VAPID_SUBJECT?.trim() ?? '';
  if (!publicKey && !privateKey) return undefined;
  if (!/^[A-Za-z0-9_-]{87}$/.test(publicKey) || !/^[A-Za-z0-9_-]{43}$/.test(privateKey)) {
    throw new Error(
      'SIPGES_VAPID_PUBLIC_KEY and SIPGES_VAPID_PRIVATE_KEY must be base64url P-256 keys (pnpm --filter @sipges/api vapid:keys)',
    );
  }
  if (!/^(mailto:[^\s@]+@[^\s@]+|https:\/\/\S+)$/.test(subject)) {
    throw new Error('SIPGES_VAPID_SUBJECT must be a mailto: address or an https URL');
  }
  return { publicKey, privateKey, subject };
};

const parseOcr = (env: Env): AppConfig['ocr'] => {
  const engine = env.SIPGES_OCR?.trim() ?? '';
  if (!engine) return undefined;
  if (engine !== 'ocrmypdf') throw new Error('SIPGES_OCR must be "ocrmypdf" or unset');
  const languages = env.SIPGES_OCR_LANGUAGES?.trim() || 'spa+eng';
  if (!/^[a-z_]{3,16}(\+[a-z_]{3,16}){0,5}$/.test(languages)) {
    throw new Error('SIPGES_OCR_LANGUAGES must be Tesseract codes joined by +, e.g. spa+eng');
  }
  return { languages };
};

/** Validates the whole environment once, before any resource is created. */
export const loadConfig = (env: Env): AppConfig => ({
  cookieSecure: parseSwitch('SIPGES_COOKIE_SECURE', env.SIPGES_COOKIE_SECURE, true),
  host: env.SIPGES_HOST ?? '127.0.0.1',
  port: parsePort(env.SIPGES_PORT),
  dataKey: parseDataKey(env.SIPGES_DATA_KEY),
  admin: {
    username: (env.SIPGES_ADMIN_USERNAME ?? 'admin').trim().toLowerCase(),
    password: env.SIPGES_ADMIN_PASSWORD ?? '',
    fullName: env.SIPGES_ADMIN_FULL_NAME?.trim() || 'Administrator',
  },
  databaseUrl: parseDatabaseUrl(env),
  pgliteDir: env.SIPGES_PGLITE_DIR ?? '.data/pglite',
  trustProxy: parseSwitch('SIPGES_TRUST_PROXY', env.SIPGES_TRUST_PROXY, false),
  maxUploadBytes: parseMaxUpload(env.SIPGES_MAX_UPLOAD_BYTES),
  storage: parseStorage(env),
  ollama: parseOllama(env),
  semanticSearch: parseSwitch('SIPGES_SEMANTIC_SEARCH', env.SIPGES_SEMANTIC_SEARCH, false),
  analyst: parseAnalyst(env),
  webDir: env.SIPGES_WEB_DIR || undefined,
  requireMfa: parseSwitch('SIPGES_REQUIRE_MFA', env.SIPGES_REQUIRE_MFA, true),
  accessLog: parseSwitch('SIPGES_ACCESS_LOG', env.SIPGES_ACCESS_LOG, true),
  allowedHosts: parseAllowedHosts(env.SIPGES_ALLOWED_HOSTS),
  google: parseGoogle(env),
  automation: parseAutomation(env),
  ocr: parseOcr(env),
});
