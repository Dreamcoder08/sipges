import { lookup } from 'node:dns/promises';
import type { FeedGateway } from '../application/media-monitor.ts';
import { feedUrlProblem, isPrivateAddress, parseFeed } from '../domain/feeds.ts';

const TIMEOUT_MS = 8000;
const MAX_BYTES = 1024 * 1024;

type Resolve = (host: string) => Promise<readonly string[]>;
const resolveAll: Resolve = async (host) =>
  (await lookup(host, { all: true, verbatim: true })).map((entry) => entry.address);

/**
 * Reads public RSS/Atom feeds (docs/adr/0021 §1): https only, the host must resolve to public
 * addresses, no redirects, at most 8 s and 1 MB.
 */
export const createRssFeedGateway = (
  deps: { fetch?: typeof fetch; resolve?: Resolve } = {},
): FeedGateway => ({
  async read(url) {
    if (feedUrlProblem(url)) throw new Error('feed_invalid_url');
    let addresses: readonly string[];
    try {
      addresses = await (deps.resolve ?? resolveAll)(new URL(url).hostname);
    } catch {
      throw new Error('feed_unresolved');
    }
    if (!addresses.length) throw new Error('feed_unresolved');
    if (addresses.some(isPrivateAddress)) throw new Error('feed_blocked_address');

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const response = await (deps.fetch ?? fetch)(url, {
        redirect: 'manual',
        signal: controller.signal,
        headers: {
          accept:
            'application/rss+xml, application/atom+xml, application/xml;q=0.9, text/xml;q=0.8',
          'user-agent': 'MASCLI-Monitoreo/1.0 (+https://github.com/Dreamcoder08/mascli)',
        },
      });
      if (response.status >= 300 && response.status < 400) {
        await response.body?.cancel();
        throw new Error('feed_redirect');
      }
      if (!response.ok || !response.body) throw new Error('feed_unavailable');
      if (Number(response.headers.get('content-length')) > MAX_BYTES) {
        await response.body.cancel();
        throw new Error('feed_too_large');
      }
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        size += part.value.byteLength;
        if (size > MAX_BYTES) {
          await reader.cancel();
          throw new Error('feed_too_large');
        }
        chunks.push(part.value);
      }
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
      }
      const head = new TextDecoder('latin1').decode(bytes.subarray(0, 200));
      const latin1 = /encoding=["'](iso-8859-1|latin1|windows-1252)["']/i.test(head);
      const text = new TextDecoder(latin1 ? 'windows-1252' : 'utf-8').decode(bytes);
      const items = parseFeed(text);
      if (!items.length && !/<(rss|feed|rdf:RDF)[\s>]/i.test(text))
        throw new Error('feed_not_a_feed');
      return items;
    } catch (error) {
      if (error instanceof Error && /^feed_[a-z_]+$/.test(error.message)) throw error;
      throw new Error(controller.signal.aborted ? 'feed_timeout' : 'feed_unavailable', {
        cause: error,
      });
    } finally {
      clearTimeout(timer);
    }
  },
});
