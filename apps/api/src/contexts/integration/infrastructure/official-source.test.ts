import { describe, expect, it } from 'vitest';
import { createOfficialSourceGateway } from './official-source.ts';
const entry = {
  id: 17,
  link: 'https://www.defensoria.gob.pe/example',
  date_gmt: '2026-10-17T10:00:00',
  title: { rendered: '<b>Aviso &amp; evidencia</b>' },
  excerpt: { rendered: '<p>Texto <script>bad()</script>oficial</p>' },
};
describe('fixed official source', () => {
  it('uses fixed HTTPS API, refuses redirects and returns plain metadata', async () => {
    let called = '';
    const gateway = createOfficialSourceGateway({
      fetch: async (url, init) => {
        called = String(url);
        expect(init?.redirect).toBe('error');
        return Response.json([entry]);
      },
    });
    expect(await gateway.preview('agua')).toEqual([
      {
        id: 17,
        url: entry.link,
        title: 'Aviso & evidencia',
        excerpt: 'Texto oficial',
        published_at: '2026-10-17T10:00:00.000Z',
      },
    ]);
    expect(called).toMatch(/^https:\/\/www.defensoria.gob.pe\/wp-json\/wp\/v2\/posts\?/);
  });
  it('fails visibly on off-host links and oversized bodies', async () => {
    const unsafe = createOfficialSourceGateway({
      fetch: async () => Response.json([{ ...entry, link: 'https://attacker.test/item' }]),
    });
    await expect(unsafe.preview('')).rejects.toThrow('source_invalid_data');
    const huge = createOfficialSourceGateway({
      fetch: async () => new Response(' '.repeat(512 * 1024 + 1)),
    });
    await expect(huge.preview('')).rejects.toThrow('source_response_too_large');
  });
});
it('refuses explicit ports and impossible dates', async () => {
  for (const invalid of [
    { ...entry, link: 'https://www.defensoria.gob.pe:443/example' },
    { ...entry, date_gmt: '2026-02-31T10:00:00' },
  ]) {
    const gateway = createOfficialSourceGateway({ fetch: async () => Response.json([invalid]) });
    await expect(gateway.preview('')).rejects.toThrow('source_invalid_data');
  }
});
