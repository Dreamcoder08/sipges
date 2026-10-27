import { MediaFeedPreview, MediaMonitorState } from '@mascli/contracts';
import { describe, expect, it } from 'vitest';
import type { FeedGateway } from '../../src/contexts/integration/application/media-monitor.ts';
import { checkRoleAccess } from '../../src/contexts/identity/domain/access-policy.ts';
import { parseFeed } from '../../src/contexts/integration/domain/feeds.ts';
import { createTestApp } from '../support/test-app.ts';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = Record<string, any>;

const CRON_SECRET = 'cron-secret-synthetic-0123456789';
const FEED_URL = 'https://radio.example.pe/feed';

/** Synthetic regional radio feed: two relevant items and one unrelated. */
const RSS = `<rss version="2.0"><channel><title>Radio sintética</title>
<item><title>Comuneros anuncian paro por contaminación del agua</title>
  <link>https://radio.example.pe/paro-agua</link><guid>r-1</guid>
  <pubDate>Sun, 11 Oct 2026 22:00:00 -0500</pubDate>
  <description>El frente de defensa sintético pide mesa de diálogo.</description></item>
<item><title>Mesa de diálogo sobre empleo local</title>
  <link>https://radio.example.pe/empleo</link><guid>r-2</guid>
  <description>Reunión prevista.</description></item>
<item><title>Festival gastronómico</title>
  <link>https://radio.example.pe/festival</link><guid>r-3</guid></item>
</channel></rss>`;

const FEED = {
  name: 'Radio sintética del norte',
  url: FEED_URL,
  keywords: ['contaminación', 'Empleo local'],
  territory: 'Distrito Ejemplo',
  authorization_note: 'Fuente pública aprobada por el titular (sintético).',
};

const setup = async () => {
  const reads: string[] = [];
  let fail = false;
  const feedGateway: FeedGateway = {
    read: async (url) => {
      reads.push(url);
      if (fail) throw new Error('feed_timeout');
      return parseFeed(RSS);
    },
  };
  const t = await createTestApp({ MASCLI_CRON_SECRET: CRON_SECRET }, { feedGateway });
  const admin = await t.login('admin', 'admin-password-123');
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await t.request(path, {
      method,
      headers: {
        cookie: admin.cookie,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: res.status, body: (await res.json()) as Json };
  };
  const cron = async () =>
    (
      await t.request('/system/automations/cron', {
        method: 'POST',
        headers: { origin: '', authorization: `Bearer ${CRON_SECRET}` },
      })
    ).status;
  const narratives = () =>
    t.sql.query<{ id: string; payload: Json }>(
      "SELECT id, payload FROM module_records WHERE module = 'Narrativas' ORDER BY id",
    );
  return { t, call, cron, narratives, reads, setFail: (value: boolean) => (fail = value) };
};

describe('media monitoring by RSS (ADR 0021)', () => {
  it('registers feeds with validation and audit, admin-only', async () => {
    const { t, call } = await setup();
    expect(
      (await call('POST', '/system/v4/media/feeds', { ...FEED, url: 'http://radio.example.pe/f' }))
        .body,
    ).toEqual({ detail: 'La URL debe empezar con https://' });
    expect(
      (await call('POST', '/system/v4/media/feeds', { ...FEED, authorization_note: '' })).status,
    ).toBe(422);
    const created = await call('POST', '/system/v4/media/feeds', FEED);
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({
      id: expect.any(Number),
      enabled: true,
      keywords: FEED.keywords,
    });
    expect((await call('POST', '/system/v4/media/feeds', FEED)).body).toEqual({
      detail: 'Esa fuente ya está registrada',
    });
    const state = MediaMonitorState.parse((await call('GET', '/system/v4/media')).body);
    expect(state).toMatchObject({ poll_minutes: 30, max_feeds: 20 });
    expect(state).not.toHaveProperty('active');
    expect(state.feeds).toHaveLength(1);
    expect(
      await t.sql.query("SELECT detail FROM audit WHERE module = 'Monitoreo de medios'"),
    ).toEqual([{ detail: `Fuente agregada: ${FEED.name} (${FEED_URL})` }]);
    for (const role of ['analista', 'coordinador', 'consulta'] as const) {
      expect(checkRoleAccess(role, 'POST', '/system/v4/media/feeds').allowed).toBe(false);
      expect(checkRoleAccess(role, 'GET', '/system/v4/media').allowed).toBe(true);
    }
    const id = created.body.id as number;
    expect(
      (await call('PUT', `/system/v4/media/feeds/${id}`, { ...FEED, enabled: false })).body,
    ).toMatchObject({ enabled: false });
    expect((await call('DELETE', `/system/v4/media/feeds/${id}`)).status).toBe(200);
    expect((await call('DELETE', `/system/v4/media/feeds/${id}`)).status).toBe(404);
  });

  it('polls configured feeds and imports each matching item once as a narrative', async () => {
    const { t, call, cron, narratives, reads } = await setup();
    await call('POST', '/system/automations/rules', {
      name: 'Noticias nuevas',
      module: 'Narrativas',
      actions: ['CREATE'],
      conditions: [],
      steps: [{ kind: 'notify', title: 'Noticia {id}' }],
    });
    expect(await cron()).toBe(200);
    expect(reads).toEqual([]);
    const created = await call('POST', '/system/v4/media/feeds', FEED);
    const id = created.body.id as number;

    // A paused feed is never fetched.
    await call('PUT', `/system/v4/media/feeds/${id}`, { ...FEED, enabled: false });
    expect(await cron()).toBe(200);
    expect(reads).toEqual([]);
    expect(await narratives()).toEqual([]);

    await call('PUT', `/system/v4/media/feeds/${id}`, { ...FEED, enabled: true });
    expect(await cron()).toBe(200);
    expect(reads).toEqual([FEED_URL]);
    const rows = await narratives();
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => /^SRC-RSS-[0-9a-f]{24}$/.test(r.id))).toBe(true);
    const water = rows.find((r) => r.payload.Fuente_ID_Externo === 'r-1')?.payload;
    expect(water).toMatchObject({
      Descripcion:
        'Comuneros anuncian paro por contaminación del agua\n\nEl frente de defensa sintético pide mesa de diálogo.',
      Tema: 'contaminación',
      Palabras_Clave: 'contaminación',
      URL_Publicacion: 'https://radio.example.pe/paro-agua',
      'Plataforma/Fuente': FEED.name,
      Tipo_Fuente: 'Medio digital (RSS)',
      Territorio: 'Distrito Ejemplo',
      Fecha_Observacion: '2026-10-11',
      Fuente_Integracion: 'rss',
      Fuente_Publicada_En: '2026-10-12T03:00:00.000Z',
    });
    // Without a date the item is dated the day it was observed (in Peru).
    expect(rows.find((r) => r.payload.Fuente_ID_Externo === 'r-2')?.payload).toMatchObject({
      Tema: 'Empleo local',
      Fecha_Observacion: '2026-10-12',
    });
    const inbox = await call('GET', '/system/notifications');
    expect(inbox.body.unread).toBe(2);

    // Within 30 minutes the cron leaves the feed alone; a manual poll reads it and finds duplicates.
    expect(await cron()).toBe(200);
    expect(reads).toHaveLength(1);
    const manual = await call('POST', '/system/v4/media/poll', {});
    expect(manual.body).toEqual({ feeds: 1, imported: 0, duplicates: 2, errors: 0 });
    expect(await narratives()).toHaveLength(2);

    t.clock.advance(31 * 60);
    expect(await cron()).toBe(200);
    expect(reads).toHaveLength(3);
    const [feed] = MediaMonitorState.parse((await call('GET', '/system/v4/media')).body).feeds;
    expect(feed).toMatchObject({ last_imported: 0, last_matched: 2, last_poll_error: '' });
  });

  it('records a failing feed without stopping the cron', async () => {
    const { call, cron, setFail } = await setup();
    await call('POST', '/system/v4/media/feeds', FEED);
    setFail(true);
    expect(await cron()).toBe(200);
    const [feed] = MediaMonitorState.parse((await call('GET', '/system/v4/media')).body).feeds;
    expect(feed).toMatchObject({ last_poll_error: 'La fuente no respondió a tiempo.' });
  });

  it('previews a feed with the keywords each item matches, saving nothing', async () => {
    const { call, narratives } = await setup();
    const preview = await call('POST', '/system/v4/media/preview', {
      url: FEED_URL,
      keywords: ['agua'],
    });
    expect(preview.status).toBe(200);
    const parsed = MediaFeedPreview.parse(preview.body);
    expect(parsed.total).toBe(3);
    expect(parsed.items.map((i) => i.matched)).toEqual([['agua'], [], []]);
    expect(await narratives()).toEqual([]);
    expect(
      (await call('POST', '/system/v4/media/preview', { url: 'https://localhost/feed' })).status,
    ).toBe(422);
  });
});
