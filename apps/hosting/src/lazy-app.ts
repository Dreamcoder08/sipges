import { Hono } from 'hono';

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
    } catch {
      // Database connection errors can contain sensitive URLs: never print them.
      c.header('Cache-Control', 'no-store');
      return c.json({ detail: 'La demo no está disponible temporalmente' }, 503);
    }
  });
  return app;
};
