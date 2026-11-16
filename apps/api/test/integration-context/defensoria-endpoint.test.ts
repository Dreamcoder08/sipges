import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { createTestApp } from '../support/test-app.ts';

const CRON_SECRET = 'cron-secret-synthetic-0123456789';
const PATH = '/wp-json/wp/v2/posts';

/** A synthetic Defensoría WordPress API on loopback: no test reaches the real site. */
const servers: Server[] = [];
const startDouble = async () => {
  const asked: string[] = [];
  const server = createServer((request, response) => {
    asked.push(request.url ?? '');
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end('[]');
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return { asked, url: `http://127.0.0.1:${port}${PATH}` };
};
afterEach(async () => {
  for (const server of servers.splice(0))
    await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('SIPGES_DEFENSORIA_URL routes the Defensoría connector', () => {
  it('sends the preview and the cron poll to the configured endpoint only', async () => {
    const double = await startDouble();
    const t = await createTestApp({
      SIPGES_CRON_SECRET: CRON_SECRET,
      SIPGES_DEFENSORIA_URL: double.url,
    });
    const admin = await t.login('admin', 'admin-password-123');
    const headers = { cookie: admin.cookie, 'content-type': 'application/json' };

    const preview = await t.request('/system/intelligence/sources/defensoria/preview?query=agua', {
      headers,
    });
    expect(preview.status).toBe(200);
    expect(await preview.json()).toEqual([]);
    expect(double.asked).toEqual([
      `${PATH}?per_page=10&search=agua&_fields=id%2Clink%2Cdate_gmt%2Ctitle%2Cexcerpt`,
    ]);

    const config = await t.request('/system/intelligence/sources/defensoria/config', {
      method: 'PUT',
      headers,
      body: JSON.stringify({
        enabled: true,
        query: 'tierra',
        territory: '',
        authorization_note: 'Convenio sintético',
      }),
    });
    expect(config.status).toBe(200);
    const cron = await t.request('/system/automations/cron', {
      method: 'POST',
      headers: { origin: '', authorization: `Bearer ${CRON_SECRET}` },
    });
    expect(cron.status).toBe(200);
    expect(double.asked).toHaveLength(2);
    expect(double.asked[1]).toBe(
      `${PATH}?per_page=10&search=tierra&_fields=id%2Clink%2Cdate_gmt%2Ctitle%2Cexcerpt`,
    );
    const state = await t.request('/system/intelligence/sources', { headers });
    expect(await state.json()).toMatchObject({
      state: { enabled: true, last_poll_error: '', last_imported: 0, last_duplicates: 0 },
    });
  });
});
