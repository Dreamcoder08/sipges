import type { ParityCase } from '../types.ts';

/**
 * Device notifications (T52): /system/notifications/push and its state, test and unsubscribe.
 * Neither API receives SIPGES_VAPID_* here, so push is off on both and no case can reach a push
 * service: the answers with keys are pinned by
 * apps/api-go/internal/app/automation_push_integration_test.go, with a transport double.
 */
const PUSH = '/system/notifications/push';
const STATE = `${PUSH}/state`;
const TEST = `${PUSH}/test`;
const UNSUBSCRIBE = `${PUSH}/unsubscribe`;

const endpoint = 'https://fcm.googleapis.com/fcm/send/parity';
const keys = { p256dh: `B${'a'.repeat(86)}`, auth: 'b'.repeat(22) };

const gateCases = (route: string, method: 'GET' | 'POST', path: string): ParityCase[] => {
  const write = method === 'POST' ? ({ sameOrigin: true } as const) : {};
  return [
    { name: `push ${route} without a session`, method, path, ...write },
    { name: `push ${route} by the read-only role`, method, path, auth: 'consulta', ...write },
    { name: `push ${route} by an administrator`, method, path, auth: 'admin', ...write },
    {
      name: `push ${route} by a two-project user before choosing`,
      method,
      path,
      auth: 'multi',
      ...write,
    },
    {
      name: `push ${route} of a project not granted`,
      method,
      path,
      auth: 'consulta',
      headers: { 'x-sipges-scope': 'PARITY/OTRO' },
      ...write,
    },
    {
      name: `push ${route} with a trailing slash`,
      method,
      path: `${path}/`,
      auth: 'admin',
      ...write,
    },
  ];
};

const bodyCases = (route: string, path: string, bodies: readonly unknown[]): ParityCase[] =>
  bodies.map((json, index): ParityCase => ({
    name: `push ${route} body ${index}: ${JSON.stringify(json).slice(0, 60)}`,
    method: 'POST',
    path,
    auth: 'consulta',
    sameOrigin: true,
    body: { json },
  }));

export const seed = '';

export const cases: readonly ParityCase[] = [
  ...gateCases('config', 'GET', PUSH),
  ...gateCases('state', 'GET', STATE),
  ...gateCases('test', 'POST', TEST),
  { name: 'push config by HEAD', method: 'HEAD', path: PUSH, auth: 'admin' },
  { name: 'push state by HEAD', method: 'HEAD', path: STATE, auth: 'admin' },
  ...bodyCases('subscribe', PUSH, [
    { endpoint, keys },
    { endpoint, keys, expirationTime: null },
    { endpoint: 'https://evil.example/x', keys },
    { endpoint: 'x'.repeat(1001), keys },
    { endpoint, keys: { p256dh: 'x'.repeat(201), auth: 'y'.repeat(101) } },
    { endpoint, keys: { p256dh: 5 } },
    { endpoint, keys: [] },
    { endpoint },
    { keys },
    {},
    [],
    null,
  ]),
  ...bodyCases('unsubscribe', UNSUBSCRIBE, [
    { endpoint },
    { endpoint: '' },
    { endpoint: 'x'.repeat(1001) },
    { endpoint: 5 },
    {},
    [],
  ]),
  {
    name: 'push subscribe without a session',
    method: 'POST',
    path: PUSH,
    sameOrigin: true,
    body: { json: { endpoint, keys } },
  },
  {
    name: 'push subscribe from another origin',
    method: 'POST',
    path: PUSH,
    auth: 'consulta',
    body: { json: { endpoint, keys } },
  },
  {
    name: 'push unsubscribe without a session',
    method: 'POST',
    path: UNSUBSCRIBE,
    sameOrigin: true,
    body: { json: { endpoint } },
  },
];
