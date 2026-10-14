/** Outbound destinations an administrator configures (docs/adr/0014 §5). Pure validation. */

export const CHANNEL_KINDS = [
  'webhook',
  'slack',
  'teams',
  'discord',
  'gchat',
  'telegram',
  'email',
] as const;
export type ChannelKind = (typeof CHANNEL_KINDS)[number];

export const isChannelKind = (value: string): value is ChannelKind =>
  (CHANNEL_KINDS as readonly string[]).includes(value);

/** Secret settings, sealed at rest and never returned by the API. */
export type ChannelConfig =
  | { readonly kind: 'webhook'; readonly url: string; readonly secret: string }
  | { readonly kind: 'slack' | 'teams' | 'discord' | 'gchat'; readonly url: string }
  | { readonly kind: 'telegram'; readonly botToken: string; readonly chatId: string }
  | {
      readonly kind: 'email';
      readonly apiKey: string;
      readonly from: string;
      readonly to: readonly string[];
    };

/** Expected host of each chat service's incoming webhooks, so a typo cannot leak elsewhere. */
const CHAT_HOSTS: Record<'slack' | 'discord' | 'gchat', RegExp> = {
  slack: /^hooks\.slack\.com$/,
  discord: /^(discord\.com|discordapp\.com)$/,
  gchat: /^chat\.googleapis\.com$/,
};

const PRIVATE_V4 = [
  /^0\./,
  /^10\./,
  /^127\./,
  /^169\.254\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^192\.168\./,
  /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./,
];

/** Literal loopback, link-local, private or reserved addresses and local names are refused. */
export const isPrivateHost = (hostname: string): boolean => {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) return true;
  if (host.endsWith('.internal')) return true;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return PRIVATE_V4.some((re) => re.test(host));
  if (host.includes(':')) {
    return (
      host === '::' ||
      host === '::1' ||
      /^f[cd]/.test(host) ||
      /^fe[89ab]/.test(host) ||
      host.startsWith('::ffff:')
    );
  }
  return !host.includes('.');
};

export type ChannelError = 'invalid_url' | 'private_host' | 'wrong_host' | 'invalid_settings';

const checkUrl = (raw: string, expectedHost?: RegExp): ChannelError | URL => {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return 'invalid_url';
  }
  if (url.protocol !== 'https:' || url.username || url.password || raw.length > 1000)
    return 'invalid_url';
  if (isPrivateHost(url.hostname)) return 'private_host';
  if (expectedHost && !expectedHost.test(url.hostname)) return 'wrong_host';
  return url;
};

const EMAIL = /^[^\s@<>()]{1,64}@[a-z0-9.-]{1,190}\.[a-z]{2,24}$/i;
const SENDER = /^([^<>]{1,80}<)?[^\s@<>()]{1,64}@[a-z0-9.-]{1,190}\.[a-z]{2,24}>?$/i;

export type ValidChannel = { readonly config: ChannelConfig; readonly targetHint: string };

const text = (value: unknown) => (typeof value === 'string' ? value.trim() : '');

/** Validates raw settings for `kind`; returns the sealed-to-be config and a safe hint. */
export const validateChannel = (
  kind: ChannelKind,
  settings: Readonly<Record<string, unknown>>,
): ValidChannel | ChannelError => {
  switch (kind) {
    case 'webhook': {
      const url = checkUrl(text(settings.url));
      if (!(url instanceof URL)) return url;
      const secret = text(settings.secret);
      if (secret.length < 24 || secret.length > 200) return 'invalid_settings';
      return { config: { kind, url: url.href, secret }, targetHint: url.host };
    }
    case 'slack':
    case 'discord':
    case 'gchat': {
      const url = checkUrl(text(settings.url), CHAT_HOSTS[kind]);
      if (!(url instanceof URL)) return url;
      return { config: { kind, url: url.href }, targetHint: url.host };
    }
    case 'teams': {
      // Teams workflows post to Power Automate / Logic Apps hosts that vary per tenant.
      const url = checkUrl(text(settings.url));
      if (!(url instanceof URL)) return url;
      return { config: { kind, url: url.href }, targetHint: url.host };
    }
    case 'telegram': {
      const botToken = text(settings.bot_token);
      const chatId = text(settings.chat_id);
      if (!/^\d{5,15}:[A-Za-z0-9_-]{30,50}$/.test(botToken)) return 'invalid_settings';
      if (!/^(-?\d{1,20}|@[A-Za-z0-9_]{5,32})$/.test(chatId)) return 'invalid_settings';
      return { config: { kind, botToken, chatId }, targetHint: `chat ${chatId}` };
    }
    case 'email': {
      const apiKey = text(settings.api_key);
      const from = text(settings.from);
      const to = (Array.isArray(settings.to) ? settings.to : text(settings.to).split(','))
        .map(text)
        .filter(Boolean);
      if (!/^re_[A-Za-z0-9_]{10,120}$/.test(apiKey) || !SENDER.test(from))
        return 'invalid_settings';
      if (to.length === 0 || to.length > 20 || !to.every((a) => EMAIL.test(a)))
        return 'invalid_settings';
      return { config: { kind, apiKey, from, to }, targetHint: maskList(to) };
    }
  }
};

const maskList = (addresses: readonly string[]) => {
  const [first = ''] = addresses;
  const [user = '', domain = ''] = first.split('@');
  const masked = `${user.slice(0, 2)}…@${domain}`;
  return addresses.length > 1 ? `${masked} y ${addresses.length - 1} más` : masked;
};
