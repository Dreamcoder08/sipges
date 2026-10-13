import { serve } from '@hono/node-server';
import { createApp } from './app.ts';
import { loadConfig } from './platform/config.ts';

// Composition root: validate configuration first, then build adapters and the app.
const config = loadConfig(process.env);
const app = createApp({ config });

serve({ fetch: app.fetch, hostname: config.host, port: config.port }, (info) => {
  console.log(`MASCLI API listening on http://${info.address}:${info.port}`);
});
