import { Hono } from 'hono';

// Exact, authored messages only: never expose arbitrary exception text or environment values.
const configurationCodes = new Map([
  ['SIPGES_DATA_KEY is required (base64, 32 bytes)', 'ERR_CONFIG_DATA_KEY_MISSING'],
  ['SIPGES_DATA_KEY must decode to 32 bytes', 'ERR_CONFIG_DATA_KEY_INVALID'],
  ['SIPGES_DATABASE_URL is required when NODE_ENV=production', 'ERR_CONFIG_DATABASE_URL_MISSING'],
]);

/** One initialization per warm instance; a failed attempt can recover on the next request. */
type Backend = { fetch(request: Request): Response | Promise<Response> };
export const createHostedApp = (initialize: () => Promise<Backend>) => {
  let pending: Promise<Backend> | undefined;
  const app = new Hono();
  app.all('*', async (c) => {
    try {
      pending ??= initialize().catch((error: unknown) => {
        pending = undefined;
        throw error;
      });
      const backend = await pending;
      return await backend.fetch(c.req.raw);
    } catch (error) {
      const code =
        (error instanceof Error ? configurationCodes.get(error.message) : undefined) ??
        (error &&
        typeof error === 'object' &&
        'code' in error &&
        typeof error.code === 'string' &&
        /^(?:[0-9A-Z]{5}|ERR_[A-Z_]+|E[A-Z]{2,30})$/.test(error.code)
          ? error.code
          : 'unclassified');
      console.error('SIPGES demo initialization failed', { code });
      // Database connection errors can contain sensitive URLs: never print them.
      c.header('Cache-Control', 'no-store');
      return c.json({ detail: 'La demo no está disponible temporalmente' }, 503);
    }
  });
  return app;
};
