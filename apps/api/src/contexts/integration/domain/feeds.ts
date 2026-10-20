/**
 * Public RSS 2.0 / Atom feeds for media monitoring (docs/adr/0021 §1). Pure: no I/O.
 * A small reader on purpose: it never expands entities or follows references, it only keeps
 * title, link, id, date and a plain-text summary of each item.
 */

export type FeedItem = {
  /** guid, Atom id or link: what makes the item the same item on the next poll. */
  readonly key: string;
  readonly title: string;
  readonly link: string;
  readonly summary: string;
  /** ISO date-time, or null when the feed gives none or an unreadable one. */
  readonly publishedAt: string | null;
};

/** Items read from one feed; feeds are newest first, so older ones are left for later. */
export const MAX_FEED_ITEMS = 50;
export const MAX_FEED_KEYWORDS = 30;

const XML_ENTITIES: Readonly<Record<string, string>> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};

const decodeEntities = (value: string) =>
  value.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, entity: string) => {
    if (!entity.startsWith('#')) return XML_ENTITIES[entity.toLowerCase()] ?? match;
    const code = entity.toLowerCase().startsWith('#x')
      ? parseInt(entity.slice(2), 16)
      : Number(entity.slice(1));
    return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '';
  });

/** HTML or text to one line of plain text. */
export const plainText = (value: string) =>
  decodeEntities(
    value.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, '').replace(/<[^>]*>/g, ' '),
  )
    .replace(/\s+/g, ' ')
    .trim();

/** Text content of an element: CDATA as is, otherwise XML-decoded (it may hold escaped HTML). */
const content = (raw: string) => {
  const cdata = /^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/.exec(raw);
  return plainText(cdata ? (cdata[1] ?? '') : decodeEntities(raw));
};

const element = (block: string, names: readonly string[]) => {
  for (const name of names) {
    const match = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, 'i').exec(block);
    if (match) return content(match[1] ?? '');
  }
  return '';
};

const httpUrl = (value: string) => {
  try {
    const url = new URL(value.trim());
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : null;
  } catch {
    return null;
  }
};

/** Atom: the alternate link, or the first link without rel. */
const atomLink = (block: string) => {
  for (const tag of block.match(/<link\b[^>]*>/gi) ?? []) {
    const rel = /\brel\s*=\s*["']([^"']*)["']/i.exec(tag)?.[1] ?? 'alternate';
    const href = /\bhref\s*=\s*["']([^"']*)["']/i.exec(tag)?.[1];
    if (rel === 'alternate' && href) return httpUrl(decodeEntities(href));
  }
  return null;
};

const isoDate = (value: string) => {
  if (!value) return null;
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
};

/** Items of an RSS 2.0, RSS 1.0 or Atom document; [] when it is none of them. */
export const parseFeed = (xml: string): FeedItem[] => {
  const atom = !/<item[\s>]/i.test(xml) && /<entry[\s>]/i.test(xml);
  const blocks = xml.match(
    atom ? /<entry[\s>][\s\S]*?<\/entry>/gi : /<item[\s>][\s\S]*?<\/item>/gi,
  );
  const items: FeedItem[] = [];
  for (const block of (blocks ?? []).slice(0, MAX_FEED_ITEMS)) {
    const link = atom ? atomLink(block) : httpUrl(element(block, ['link']));
    const id = element(block, atom ? ['id'] : ['guid']);
    const key = (id || link || '').slice(0, 500);
    const title = element(block, ['title']).slice(0, 500);
    if (!key || !link || !title) continue;
    items.push({
      key,
      title,
      link,
      summary: element(
        block,
        atom ? ['summary', 'content'] : ['description', 'content:encoded'],
      ).slice(0, 1500),
      publishedAt: isoDate(
        element(block, atom ? ['published', 'updated'] : ['pubDate', 'dc:date']),
      ),
    });
  }
  return items;
};

/** Lower case without accents, so «Contaminación» matches «contaminacion». */
export const fold = (value: string) => value.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();

/** Keywords the item mentions; with no keywords every item is relevant. */
export const matchedKeywords = (item: FeedItem, keywords: readonly string[]) => {
  const text = ` ${fold(`${item.title} ${item.summary}`).replace(/[^\p{L}\p{N}]+/gu, ' ')} `;
  return keywords.filter((keyword) => {
    const words = fold(keyword)
      .replace(/[^\p{L}\p{N}]+/gu, ' ')
      .trim();
    return words !== '' && text.includes(` ${words} `);
  });
};

const INTERNAL_SUFFIXES = [
  '.local',
  '.localhost',
  '.internal',
  '.lan',
  '.home',
  '.corp',
  '.intranet',
];

/**
 * Why a feed URL may not be polled, or null when it may: only https on a public host name,
 * with no credentials or port. Addresses are checked again after DNS resolution.
 */
export const feedUrlProblem = (value: string): string | null => {
  if (value.length > 500) return 'La URL es demasiado larga';
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return 'La URL no es válida';
  }
  if (url.protocol !== 'https:') return 'La URL debe empezar con https://';
  if (url.username || url.password) return 'La URL no puede incluir usuario ni contraseña';
  if (url.port) return 'La URL no puede indicar un puerto';
  const host = url.hostname.toLowerCase();
  if (/^[\d.]+$/.test(host) || host.includes(':') || host.startsWith('['))
    return 'Usa el nombre del sitio, no una dirección IP';
  if (
    !host.includes('.') ||
    host === 'localhost' ||
    INTERNAL_SUFFIXES.some((suffix) => host.endsWith(suffix))
  )
    return 'La URL debe ser de un sitio público';
  return null;
};

/** IPv4/IPv6 addresses a public feed may never resolve to (loopback, private, link-local…). */
export const isPrivateAddress = (address: string) => {
  const v4 = /^(?:::ffff:)?(\d+)\.(\d+)\.(\d+)\.(\d+)$/i.exec(address);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 198 && (b === 18 || b === 19)) ||
      a >= 224
    );
  }
  const v6 = address.toLowerCase();
  return (
    v6 === '::' ||
    v6 === '::1' ||
    v6.startsWith('fc') ||
    v6.startsWith('fd') ||
    v6.startsWith('fe8') ||
    v6.startsWith('fe9') ||
    v6.startsWith('fea') ||
    v6.startsWith('feb') ||
    v6.startsWith('ff')
  );
};
