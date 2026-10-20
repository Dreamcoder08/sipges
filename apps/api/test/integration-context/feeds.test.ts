import { describe, expect, it } from 'vitest';
import {
  type FeedItem,
  feedUrlProblem,
  isPrivateAddress,
  matchedKeywords,
  parseFeed,
} from '../../src/contexts/integration/domain/feeds.ts';

const RSS = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:atom="http://www.w3.org/2005/Atom">
<channel><title>Radio sintética del norte</title><link>https://radio.example.pe/</link>
<atom:link href="https://radio.example.pe/feed" rel="self" />
<item>
  <title><![CDATA[Comuneros piden diálogo por empleo local]]></title>
  <link>https://radio.example.pe/2026/10/dialogo-empleo</link>
  <guid isPermaLink="false">radio-101</guid>
  <pubDate>Sat, 10 Oct 2026 14:30:00 -0500</pubDate>
  <description>&lt;p&gt;La &lt;b&gt;comunidad&lt;/b&gt; de Ejemplo pide &amp;quot;mesa&amp;quot; sobre contaminaci&#243;n.&lt;/p&gt;</description>
</item>
<item>
  <title>Festival gastronómico</title>
  <link>https://radio.example.pe/2026/10/festival</link>
  <dc:date>2026-10-11T09:00:00Z</dc:date>
  <description><![CDATA[<p>Sin relación<script>alert(1)</script></p>]]></description>
</item>
<item><title>Sin enlace</title><description>x</description></item>
<item><title>Enlace raro</title><link>javascript:alert(1)</link></item>
</channel></rss>`;

const ATOM = `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom"><title>Blog sintético</title>
<entry>
  <title type="html">Paro &amp;amp; bloqueo anunciado</title>
  <link rel="self" href="https://blog.example.pe/api/1"/>
  <link href="https://blog.example.pe/paro"/>
  <id>tag:blog.example.pe,2026:1</id>
  <updated>2026-10-12T08:00:00Z</updated>
  <summary>Frente de defensa anuncia paro.</summary>
</entry>
</feed>`;

describe('feed reader (ADR 0021 §1)', () => {
  it('reads RSS items with plain text, keys and dates, skipping unusable ones', () => {
    expect(parseFeed(RSS)).toEqual([
      {
        key: 'radio-101',
        title: 'Comuneros piden diálogo por empleo local',
        link: 'https://radio.example.pe/2026/10/dialogo-empleo',
        summary: 'La comunidad de Ejemplo pide "mesa" sobre contaminación.',
        publishedAt: '2026-10-10T19:30:00.000Z',
      },
      {
        key: 'https://radio.example.pe/2026/10/festival',
        title: 'Festival gastronómico',
        link: 'https://radio.example.pe/2026/10/festival',
        summary: 'Sin relación',
        publishedAt: '2026-10-11T09:00:00.000Z',
      },
    ]);
  });

  it('reads Atom entries with their alternate link', () => {
    expect(parseFeed(ATOM)).toEqual([
      {
        key: 'tag:blog.example.pe,2026:1',
        title: 'Paro & bloqueo anunciado',
        link: 'https://blog.example.pe/paro',
        summary: 'Frente de defensa anuncia paro.',
        publishedAt: '2026-10-12T08:00:00.000Z',
      },
    ]);
  });

  it('returns nothing for documents that are not feeds', () => {
    expect(parseFeed('<html><body>Hola</body></html>')).toEqual([]);
    expect(parseFeed('')).toEqual([]);
  });

  it('matches whole keywords without case or accents', () => {
    const [dialogue, festival] = parseFeed(RSS);
    expect(
      matchedKeywords(dialogue as FeedItem, ['Contaminación', 'empleo local', 'agua']),
    ).toEqual(['Contaminación', 'empleo local']);
    expect(matchedKeywords(festival as FeedItem, ['contaminación', 'fest'])).toEqual([]);
    expect(matchedKeywords(festival as FeedItem, [])).toEqual([]);
  });

  it('accepts only https URLs on public host names', () => {
    expect(feedUrlProblem('https://radio.example.pe/feed')).toBeNull();
    for (const url of [
      'http://radio.example.pe/feed',
      'https://user:pw@radio.example.pe/feed',
      'https://radio.example.pe:8443/feed',
      'https://10.0.0.1/feed',
      'https://[::1]/feed',
      'https://localhost/feed',
      'https://intranet/feed',
      'https://metadata.google.internal/feed',
      'no es url',
    ]) {
      expect(feedUrlProblem(url), url).not.toBeNull();
    }
  });

  it('recognises private and reserved addresses', () => {
    for (const address of [
      '127.0.0.1',
      '10.1.2.3',
      '172.20.0.1',
      '192.168.1.1',
      '169.254.169.254',
      '::1',
      'fd00::1',
      '::ffff:10.0.0.1',
    ]) {
      expect(isPrivateAddress(address), address).toBe(true);
    }
    for (const address of ['200.48.225.130', '8.8.8.8', '2800:200:e840::1']) {
      expect(isPrivateAddress(address), address).toBe(false);
    }
  });
});
