import { describe, expect, it } from 'vitest';
import { createRssFeedGateway } from '../../src/contexts/integration/infrastructure/rss-feed-gateway.ts';

const RSS =
  '<rss><channel><item><title>Noticia</title><link>https://radio.example.pe/n</link></item></channel></rss>';
const PUBLIC = async () => ['200.48.225.130'];

const gateway = (response: () => Response, resolve = PUBLIC) => {
  const calls: RequestInit[] = [];
  return {
    calls,
    read: createRssFeedGateway({
      resolve,
      fetch: (async (_url: string, init: RequestInit) => {
        calls.push(init);
        return response();
      }) as typeof fetch,
    }).read,
  };
};

describe('RSS feed gateway (ADR 0021 §1)', () => {
  it('reads a public feed without following redirects', async () => {
    const g = gateway(() => new Response(RSS, { status: 200 }));
    expect(await g.read('https://radio.example.pe/feed')).toEqual([
      expect.objectContaining({ title: 'Noticia', link: 'https://radio.example.pe/n' }),
    ]);
    expect(g.calls[0]?.redirect).toBe('manual');
  });

  it('refuses hosts that resolve to private addresses before fetching', async () => {
    const g = gateway(
      () => new Response(RSS),
      async () => ['200.48.225.130', '10.0.0.5'],
    );
    await expect(g.read('https://radio.example.pe/feed')).rejects.toThrow('feed_blocked_address');
    expect(g.calls).toHaveLength(0);
    await expect(
      gateway(() => new Response(RSS)).read('http://radio.example.pe/feed'),
    ).rejects.toThrow('feed_invalid_url');
  });

  it('names redirects, errors, oversized bodies and non-feeds', async () => {
    const url = 'https://radio.example.pe/feed';
    await expect(
      gateway(
        () => new Response(null, { status: 301, headers: { location: 'https://x.pe/' } }),
      ).read(url),
    ).rejects.toThrow('feed_redirect');
    await expect(gateway(() => new Response('no', { status: 503 })).read(url)).rejects.toThrow(
      'feed_unavailable',
    );
    await expect(
      gateway(() => new Response('x'.repeat(1024 * 1024 + 1))).read(url),
    ).rejects.toThrow('feed_too_large');
    await expect(gateway(() => new Response('<html>hola</html>')).read(url)).rejects.toThrow(
      'feed_not_a_feed',
    );
    expect(await gateway(() => new Response('<rss><channel></channel></rss>')).read(url)).toEqual(
      [],
    );
  });
});
