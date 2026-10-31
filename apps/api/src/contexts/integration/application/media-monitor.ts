import { createHash } from 'node:crypto';
import type { MediaFeed, MediaFeedIn } from '@mascli/contracts';
import {
  type FeedItem,
  MAX_FEED_KEYWORDS,
  feedUrlProblem,
  matchedKeywords,
} from '../domain/feeds.ts';
import type { SourceImporter } from './authorized-sources.ts';

/** Media monitoring by public RSS/Atom feeds (docs/adr/0021). */

export const MAX_FEEDS = 20;
/** A feed is fetched at most this often by the cron; "Consultar ahora" ignores it. */
export const POLL_MINUTES = 30;
/** New items imported per feed and poll; the rest wait for the next poll. */
export const ITEMS_PER_POLL = 20;

export type FeedGateway = {
  /** Throws `feed_<reason>` errors; never follows redirects or reads private addresses. */
  read(url: string): Promise<FeedItem[]>;
};

export type FeedWrite = MediaFeedIn & { readonly actor: string; readonly at: string };

export type MediaFeedStore = {
  list(tenantId: string): Promise<MediaFeed[]>;
  create(tenantId: string, feed: FeedWrite): Promise<MediaFeed | 'duplicate' | 'limit'>;
  update(tenantId: string, id: number, feed: FeedWrite): Promise<MediaFeed | 'duplicate' | null>;
  remove(tenantId: string, id: number, actor: string, at: string): Promise<boolean>;
  /** Marks enabled feeds not polled in the last `minutes` as polled now and returns them. */
  claimDue(tenantId: string, at: string, minutes: number): Promise<MediaFeed[]>;
  finish(
    tenantId: string,
    id: number,
    at: string,
    outcome: { imported: number; matched: number; error: string },
  ): Promise<void>;
};

const FEED_ERRORS: Readonly<Record<string, string>> = {
  feed_timeout: 'La fuente no respondió a tiempo.',
  feed_unavailable: 'La fuente respondió con un error.',
  feed_redirect: 'La fuente redirige a otra dirección; registra la URL final.',
  feed_too_large: 'La respuesta de la fuente supera 1 MB.',
  feed_not_a_feed: 'La dirección no devolvió un RSS o Atom legible.',
  feed_blocked_address: 'La dirección apunta a una red privada y no se consulta.',
  feed_unresolved: 'No se encontró el sitio de la fuente.',
  feed_invalid_url: 'La URL de la fuente no es válida.',
};
export const feedErrorMessage = (error: unknown) => {
  const code = error instanceof Error ? error.message : '';
  return FEED_ERRORS[code] ?? 'No se pudo leer la fuente.';
};

/** Calendar day in Peru, where the projects are. */
const LIMA_DAY = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Lima' });

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

export type MediaInputProblem = { readonly detail: string };

const normalize = (input: MediaFeedIn): MediaFeedIn | MediaInputProblem => {
  const problem = feedUrlProblem(input.url);
  if (problem) return { detail: problem };
  const keywords = [...new Set(input.keywords.map((k) => k.trim()).filter(Boolean))];
  if (keywords.length > MAX_FEED_KEYWORDS)
    return { detail: `Máximo ${MAX_FEED_KEYWORDS} palabras clave` };
  return { ...input, url: new URL(input.url).href, keywords };
};
const isProblem = (value: unknown): value is MediaInputProblem =>
  typeof value === 'object' && value !== null && 'detail' in value;

export const createMediaMonitorService = (deps: {
  feeds: MediaFeedStore;
  gateway: FeedGateway;
  importer: SourceImporter;
  clock: () => Date;
}) => {
  const { feeds, gateway, importer, clock } = deps;

  /**
   * One narrative per item and source: the id comes from the feed URL and the item's key, so
   * the same news is never created twice, even if its text is edited later.
   */
  const importItem = (tenantId: string, feed: MediaFeed, item: FeedItem, matched: string[]) => {
    const identity = sha256(`${feed.url}\n${item.key}`);
    const observed = clock();
    return importer.createOnce(tenantId, `SRC-RSS-${identity.slice(0, 24)}`, {
      Descripcion: item.summary ? `${item.title}\n\n${item.summary}` : item.title,
      ...(matched[0] ? { Tema: matched[0] } : {}),
      URL_Publicacion: item.link,
      'Plataforma/Fuente': feed.name,
      Tipo_Fuente: 'Medio digital (RSS)',
      Fecha_Observacion: LIMA_DAY.format(item.publishedAt ? new Date(item.publishedAt) : observed),
      ...(matched.length ? { Palabras_Clave: matched.join(', ') } : {}),
      ...(feed.territory ? { Territorio: feed.territory } : {}),
      Fuente_Integracion: 'rss',
      Fuente_Huella_SHA256: identity,
      Fuente_ID_Externo: item.key,
      Fuente_Publicada_En: item.publishedAt ?? '',
      Fuente_Observada_En: observed.toISOString(),
    });
  };

  const pollFeed = async (tenantId: string, feed: MediaFeed, items: FeedItem[]) => {
    let imported = 0;
    let duplicates = 0;
    let matched = 0;
    for (const item of items) {
      const keywords = matchedKeywords(item, feed.keywords);
      if (feed.keywords.length && !keywords.length) continue;
      matched++;
      const result = await importItem(tenantId, feed, item, keywords);
      if (result.created) imported++;
      else duplicates++;
      if (imported >= ITEMS_PER_POLL) break;
    }
    return { imported, duplicates, matched };
  };

  return {
    async state(tenantId: string) {
      return {
        poll_minutes: POLL_MINUTES,
        max_feeds: MAX_FEEDS,
        feeds: await feeds.list(tenantId),
      };
    },
    async create(tenantId: string, input: MediaFeedIn, actor: string) {
      const feed = normalize(input);
      if (isProblem(feed)) return feed;
      const saved = await feeds.create(tenantId, { ...feed, actor, at: clock().toISOString() });
      if (saved === 'duplicate') return { detail: 'Esa fuente ya está registrada' };
      if (saved === 'limit') return { detail: `Máximo ${MAX_FEEDS} fuentes por proyecto` };
      return saved;
    },
    async update(tenantId: string, id: number, input: MediaFeedIn, actor: string) {
      const feed = normalize(input);
      if (isProblem(feed)) return feed;
      const saved = await feeds.update(tenantId, id, { ...feed, actor, at: clock().toISOString() });
      if (saved === 'duplicate') return { detail: 'Esa fuente ya está registrada' };
      return saved;
    },
    remove: (tenantId: string, id: number, actor: string) =>
      feeds.remove(tenantId, id, actor, clock().toISOString()),
    /** Reads a feed without saving anything, to check it before registering it. */
    async preview(url: string, keywords: readonly string[]) {
      const problem = feedUrlProblem(url);
      if (problem) return { detail: problem };
      const items = await gateway.read(new URL(url).href);
      return {
        total: items.length,
        items: items.slice(0, ITEMS_PER_POLL).map((item) => ({
          title: item.title,
          link: item.link,
          summary: item.summary,
          published_at: item.publishedAt,
          matched: matchedKeywords(item, keywords),
        })),
      };
    },
    /**
     * Polls the project's due feeds (all enabled feeds with `force`). Fetches run in parallel;
     * imports run one by one so each narrative gets its own audit row and rule evaluation.
     */
    async poll(tenantId: string, options: { force?: boolean } = {}) {
      const report = { feeds: 0, imported: 0, duplicates: 0, errors: 0 };
      const at = clock().toISOString();
      const due = await feeds.claimDue(tenantId, at, options.force ? 0 : POLL_MINUTES);
      const reads = await Promise.allSettled(due.map((feed) => gateway.read(feed.url)));
      for (const [index, feed] of due.entries()) {
        const read = reads[index];
        report.feeds++;
        if (!read || read.status === 'rejected') {
          report.errors++;
          await feeds.finish(tenantId, feed.id, at, {
            imported: 0,
            matched: 0,
            error: feedErrorMessage(read?.reason),
          });
          continue;
        }
        try {
          const outcome = await pollFeed(tenantId, feed, read.value);
          report.imported += outcome.imported;
          report.duplicates += outcome.duplicates;
          await feeds.finish(tenantId, feed.id, at, { ...outcome, error: '' });
        } catch {
          report.errors++;
          await feeds.finish(tenantId, feed.id, at, {
            imported: 0,
            matched: 0,
            error: 'No se pudieron guardar las narrativas de esta fuente.',
          });
        }
      }
      return report;
    },
  };
};

export type MediaMonitorService = ReturnType<typeof createMediaMonitorService>;
