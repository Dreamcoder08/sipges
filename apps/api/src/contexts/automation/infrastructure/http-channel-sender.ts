import { createHmac } from 'node:crypto';
import type { ChannelSender, OutboundMessage } from '../application/ports.ts';
import type { ChannelConfig } from '../domain/channels.ts';
import { outboundTraceHeaders } from '../../../platform/observability/trace.ts';

export const SEND_TIMEOUT_MS = 10_000;

type Fetch = typeof fetch;

/**
 * Standard Webhooks signature (https://www.standardwebhooks.com): base64 HMAC-SHA256 of
 * `id.timestamp.body` keyed with the channel secret, sent as `v1,<signature>`.
 */
export const signWebhook = (secret: string, id: string, timestamp: number, body: string) =>
  `v1,${createHmac('sha256', secret).update(`${id}.${timestamp}.${body}`).digest('base64')}`;

const plain = (message: OutboundMessage) => `${message.title}\n${message.text}`;

/** Request for each channel kind: URL, extra headers and JSON body. */
const requestFor = (
  config: ChannelConfig,
  message: OutboundMessage,
): { url: string; headers: Record<string, string>; body: string } => {
  switch (config.kind) {
    case 'webhook': {
      const body = JSON.stringify({
        id: message.id,
        title: message.title,
        text: message.text,
        ...message.event,
      });
      const timestamp = Math.floor(message.at.getTime() / 1000);
      return {
        url: config.url,
        headers: {
          'webhook-id': message.id,
          'webhook-timestamp': String(timestamp),
          'webhook-signature': signWebhook(config.secret, message.id, timestamp, body),
        },
        body,
      };
    }
    case 'slack':
      return {
        url: config.url,
        headers: {},
        body: JSON.stringify({ text: `*${message.title}*\n${message.text}` }),
      };
    case 'discord':
      return {
        url: config.url,
        headers: {},
        body: JSON.stringify({
          content: plain(message).slice(0, 2000),
          allowed_mentions: { parse: [] },
        }),
      };
    case 'gchat':
      return { url: config.url, headers: {}, body: JSON.stringify({ text: plain(message) }) };
    case 'teams':
      // Teams Workflows ("when a webhook request is received") expect an Adaptive Card.
      return {
        url: config.url,
        headers: {},
        body: JSON.stringify({
          type: 'message',
          attachments: [
            {
              contentType: 'application/vnd.microsoft.card.adaptive',
              content: {
                $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
                type: 'AdaptiveCard',
                version: '1.4',
                body: [
                  { type: 'TextBlock', text: message.title, weight: 'Bolder', wrap: true },
                  { type: 'TextBlock', text: message.text, wrap: true },
                ],
              },
            },
          ],
        }),
      };
    case 'telegram':
      return {
        url: `https://api.telegram.org/bot${config.botToken}/sendMessage`,
        headers: {},
        body: JSON.stringify({
          chat_id: config.chatId,
          text: plain(message).slice(0, 4096),
          disable_web_page_preview: true,
        }),
      };
    case 'email':
      return {
        url: 'https://api.resend.com/emails',
        headers: { authorization: `Bearer ${config.apiKey}`, 'idempotency-key': message.id },
        body: JSON.stringify({
          from: config.from,
          to: config.to,
          subject: message.title,
          text: `${message.text}\n\n— Automatización de SIPGES`,
        }),
      };
  }
};

/** Sends over HTTPS without following redirects; any non-2xx answer is an error. */
export const createHttpChannelSender = (fetchImpl: Fetch = fetch): ChannelSender => ({
  async send(config, message) {
    const request = requestFor(config, message);
    let response: Response;
    try {
      response = await fetchImpl(request.url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'user-agent': 'SIPGES-Automation/1',
          // Own systems behind a signed webhook can join the trace; chat services cannot use it.
          ...(config.kind === 'webhook' ? outboundTraceHeaders() : {}),
          ...request.headers,
        },
        body: request.body,
        redirect: 'error',
        signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
      });
    } catch (error) {
      // Never echo the URL: it may embed a token.
      const reason =
        error instanceof Error && error.name === 'TimeoutError' ? 'tiempo agotado' : 'sin conexión';
      throw new Error(`Canal ${config.kind}: ${reason}`, { cause: error });
    }
    await response.body?.cancel().catch(() => undefined);
    if (!response.ok) throw new Error(`Canal ${config.kind}: respuesta HTTP ${response.status}`);
  },
});
