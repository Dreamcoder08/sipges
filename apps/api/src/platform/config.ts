export type AppConfig = {
  readonly cookieSecure: boolean;
  readonly host: string;
  readonly port: number;
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

/** Validates the whole environment once, before any resource is created. */
export const loadConfig = (env: Env): AppConfig => ({
  cookieSecure: parseCookieSecure(env.MASCLI_COOKIE_SECURE),
  host: env.MASCLI_HOST ?? '127.0.0.1',
  port: parsePort(env.MASCLI_PORT),
});
