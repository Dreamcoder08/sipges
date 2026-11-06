import { CRON_SECRET } from './synthetic.ts';
import type { ParityCase } from './types.ts';

/**
 * Writes that need what only the second stage starts with: VAPID keys for push, and Go's cron,
 * which also turns on its timer and so would change /system/automations/runtime in the first.
 * No push/test here: with a subscription in place it would call the real push service.
 */
const write = (name: string, path: string, json: unknown): ParityCase => ({
  name: `write proof: ${name}`,
  method: 'POST',
  path,
  auth: 'admin',
  sameOrigin: true,
  perApi: true,
  body: { json },
});

const endpoint = 'https://fcm.googleapis.com/fcm/send/parity-{api}';
const keys = { p256dh: `B${'a'.repeat(86)}`, auth: 'b'.repeat(22) };

export const secondStageWrites: readonly ParityCase[] = [
  write('subscribe to push', '/system/notifications/push', { endpoint, keys }),
  write('unsubscribe from push', '/system/notifications/push/unsubscribe', { endpoint }),
  {
    name: 'write proof: run the cron',
    method: 'POST',
    path: '/system/automations/cron',
    oneAtATime: true,
    headers: { authorization: `Bearer ${CRON_SECRET}` },
    normalize: ['scanned', 'queued', 'delivered', 'failed', 'retrying'],
  },
];
