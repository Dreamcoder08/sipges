// T1 viability spike: import the API exactly as the Vercel adapter does and let the bundler
// report what workerd cannot load. Not a working entrypoint yet.
import { createApp } from '../../api/src/app.ts';
import { buildContainer } from '../../api/src/compose.ts';
import { loadMigrations, migrate } from '../../api/src/platform/database/migrator.ts';

export default {
  async fetch(): Promise<Response> {
    return Response.json({
      spike: [typeof createApp, typeof buildContainer, typeof loadMigrations, typeof migrate],
    });
  },
};
