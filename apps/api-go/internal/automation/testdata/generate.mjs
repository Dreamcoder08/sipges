// Records the TypeScript automation context's answers on synthetic inputs, for the Go port's
// fixture tests (../domain/fixtures_test.go, ../http/body_fixtures_test.go and
// ../infrastructure/sender_fixtures_test.go). Run from the repository root after changing either side:
//
//   node apps/api-go/internal/automation/testdata/generate.mjs          # rewrites the fixture
//   node apps/api-go/internal/automation/testdata/generate.mjs --check  # exit 1 when it drifted
//
// Every input is synthetic: no real record, channel or credential is read.
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { format, resolveConfig } from 'prettier';
import {
  ChannelIn,
  NotificationReadIn,
  PushSubscriptionIn,
  PushUnsubscribeIn,
  RuleIn,
} from '../../../../../packages/contracts/src/automation.ts';
import {
  conditionHolds,
  describeEvent,
  renderTitle,
  retryDelayMinutes,
  ruleMatches,
  validateRule,
} from '../../../../api/src/contexts/automation/domain/rules.ts';
import {
  isPrivateHost,
  isPushEndpoint,
  validateChannel,
} from '../../../../api/src/contexts/automation/domain/channels.ts';
import { createHttpChannelSender } from '../../../../api/src/contexts/automation/infrastructure/http-channel-sender.ts';

const OUT = fileURLToPath(new URL('./fixtures.json', import.meta.url));

/** toIssues of apps/api/src/platform/http/validation.ts. */
const toIssues = (error, input) =>
  error.issues.map((issue) => {
    const missing =
      issue.code === 'invalid_type' &&
      issue.path.length > 0 &&
      (typeof input !== 'object' || input === null || !(String(issue.path[0]) in input));
    return {
      type: missing ? 'missing' : issue.code,
      loc: ['body', ...issue.path.map((p) => (typeof p === 'number' ? p : String(p)))],
      msg: missing ? 'Field required' : issue.message,
    };
  });

const parse = (schema, raw) => {
  let body;
  try {
    body = JSON.parse(raw);
  } catch {
    return {
      status: 422,
      detail: [{ type: 'json_invalid', loc: ['body'], msg: 'JSON decode error' }],
    };
  }
  const result = schema.safeParse(body);
  return result.success
    ? { status: 200, value: result.data }
    : { status: 422, detail: toIssues(result.error, body) };
};

const long = (n, c = 'a') => c.repeat(n);
const step = { kind: 'notify', title: 'Aviso {modulo}' };
const rule = { name: 'Regla', module: 'Alertas', actions: ['CREATE'], steps: [step] };
const ruleBodies = [
  rule,
  { ...rule, enabled: false, conditions: [{ field: 'Nivel', op: 'eq', value: 'Alto' }] },
  { ...rule, name: '  Regla con espacios  ' },
  { ...rule, name: '   ' },
  { ...rule, name: '' },
  { ...rule, name: long(80) },
  { ...rule, name: long(81) },
  { ...rule, name: ` ${long(79)} ` },
  { ...rule, name: `${long(40, '😀')}` },
  { ...rule, name: `${long(41, '😀')}` },
  { ...rule, name: 'a\u0000b' },
  { ...rule, name: 5 },
  { ...rule, name: null },
  { module: 'Alertas', actions: ['CREATE'], steps: [step] },
  {},
  { ...rule, enabled: 'yes' },
  { ...rule, module: '' },
  { ...rule, module: long(61) },
  { ...rule, actions: [] },
  { ...rule, actions: Array(11).fill('CREATE') },
  { ...rule, actions: ['CREATE', long(21)] },
  { ...rule, actions: 'CREATE' },
  { ...rule, actions: [1] },
  { ...rule, conditions: Array(11).fill({ field: 'a', op: 'eq' }) },
  { ...rule, conditions: [{ field: '', op: 'eq' }] },
  { ...rule, conditions: [{ field: 'a', op: 'like' }] },
  { ...rule, conditions: [{ op: 'eq' }] },
  { ...rule, conditions: [{ field: 'a', op: 'eq', value: long(201) }] },
  { ...rule, conditions: [{ field: 'a', op: 'eq', value: 5 }] },
  { ...rule, conditions: [null] },
  { ...rule, conditions: null },
  { ...rule, steps: [] },
  { ...rule, steps: Array(6).fill(step) },
  { ...rule, steps: [{ kind: 'other', title: 'x' }] },
  { ...rule, steps: [{ title: 'x' }] },
  { ...rule, steps: [{ kind: 'notify' }] },
  { ...rule, steps: [{ kind: 'notify', title: '' }] },
  { ...rule, steps: [{ kind: 'notify', title: long(201) }] },
  { ...rule, steps: [{ kind: 'channel', title: 'x' }] },
  { ...rule, steps: [{ kind: 'channel', title: 'x', channel_id: 0 }] },
  { ...rule, steps: [{ kind: 'channel', title: 'x', channel_id: 1.5 }] },
  { ...rule, steps: [{ kind: 'channel', title: 'x', channel_id: '1' }] },
  { ...rule, steps: [{ kind: 'channel', title: 'x', channel_id: 3, extra: 1 }] },
  { ...rule, steps: [{ kind: 'evaluate', title: 'x' }] },
  { ...rule, steps: [{ kind: 'evaluate', title: 'x', minimum_level: 'Baja' }] },
  { ...rule, steps: [{ kind: 'evaluate', title: 'x', minimum_level: 'Alta' }] },
  { ...rule, steps: [null] },
  { ...rule, steps: 'x' },
  { ...rule, project_id: 'PRJ-SECHURA', extra: true },
  { ...rule, actions: 'CREATE_UPDATE_DELETE' },
  { ...rule, name: Array(81).fill(1) },
  { ...rule, steps: { length: 0 } },
  { ...rule, steps: [{ kind: 'notify', title: ['a'] }] },
  {
    ...rule,
    conditions: [
      { field: 'a', op: 'eq', value: 'x\u0000' },
      { field: 'b\u0000', op: 5 },
    ],
  },
  { ...rule, name: '\u3000Regla\ufeff', enabled: null },
  { ...rule, steps: [{ kind: 'channel', title: '', channel_id: -1.5 }] },
];
const ruleRaw = [
  ...ruleBodies.map((b) => JSON.stringify(b)),
  '',
  'null',
  '[]',
  '"x"',
  '{"name":',
  '5',
  'true',
  '{"name":"a","name":"Regla","module":"Alertas","actions":["CREATE"],"steps":[{"kind":"notify","title":"t"}]}',
  `{"name":"Regla","module":"Alertas","actions":["CREATE"],"steps":[{"kind":"channel","title":"t","channel_id":1e400}]}`,
  `{"name":"Regla","module":"Alertas","actions":["CREATE"],"steps":[{"kind":"channel","title":"t","channel_id":2.0}]}`,
  `{"name":"Regla","module":"Alertas","actions":["CREATE"],"steps":[{"kind":"channel","title":"t","channel_id":9007199254740993}]}`,
];

const channelBodies = [
  {
    kind: 'webhook',
    name: 'Web',
    settings: { url: 'https://hooks.example.org/x', secret: long(24) },
  },
  { kind: 'webhook', name: '  Web  ', settings: {} },
  { kind: 'fax', name: 'x', settings: {} },
  { name: 'x', settings: {} },
  { kind: 'slack', settings: {} },
  { kind: 'slack', name: ' ', settings: {} },
  { kind: 'slack', name: long(81), settings: {} },
  { kind: 'slack', name: 'x' },
  { kind: 'slack', name: 'x', settings: [] },
  { kind: 'slack', name: 'x', settings: { url: 5 } },
  { kind: 'slack', name: 'x', settings: { url: long(1001) } },
  { kind: 'email', name: 'x', settings: { to: Array(21).fill('a@b.co') } },
  { kind: 'email', name: 'x', settings: { to: [long(201)] } },
  { kind: 'email', name: 'x', settings: { to: [5] } },
  { kind: 'email', name: 'x', settings: { to: ['a\u0000'] } },
  { kind: 'slack', name: 'x', settings: { url: 'a\u0000' } },
  { kind: 'slack', name: 'x', settings: { url: null } },
  { kind: 5, name: 5, settings: 5 },
  { kind: 'slack', name: 'x', settings: { 10: 5, b: 'ok', 2: long(1001), a: [1] } },
  { kind: 'teams', name: ' Equipo ', settings: { url: ['a', 'b'] } },
];
const channelRaw = [...channelBodies.map((b) => JSON.stringify(b)), '', 'null', '[1]'];

const readBodies = [
  { ids: [1, 2] },
  { all: true },
  { all: false },
  { ids: [] },
  { ids: Array(201).fill(1) },
  { ids: [0] },
  { ids: [1.5] },
  { ids: ['1'] },
  { ids: [1], all: true },
  {},
  { ids: null },
  { all: 'true' },
  { ids: [1e300] },
  { ids: [-1] },
  { ids: [1, 0, 2.5] },
  { ids: [5], extra: 1 },
  { ids: [-1e300] },
];
const readRaw = [...readBodies.map((b) => JSON.stringify(b)), '', 'null', '[]', '5'];

// Browser push subscriptions: the schemas, then the endpoint check of subscribePush.
const pushKeys = { p256dh: `B${'a'.repeat(86)}`, auth: 'b'.repeat(22) };
const pushEndpointOk = 'https://fcm.googleapis.com/fcm/send/synthetic';
const pushRaw = [
  ...[
    { endpoint: pushEndpointOk, keys: pushKeys },
    { endpoint: pushEndpointOk, keys: pushKeys, expirationTime: null },
    { endpoint: pushEndpointOk, keys: { ...pushKeys, extra: 1 } },
    { endpoint: '', keys: { p256dh: '', auth: '' } },
    { endpoint: 'a\u0000b', keys: pushKeys },
    { endpoint: 'x'.repeat(1000), keys: pushKeys },
    { endpoint: 'x'.repeat(1001), keys: pushKeys },
    { endpoint: '😀'.repeat(1001), keys: pushKeys },
    { endpoint: pushEndpointOk, keys: { p256dh: 'x'.repeat(201), auth: 'y'.repeat(101) } },
    { endpoint: pushEndpointOk, keys: { p256dh: 5, auth: null } },
    { endpoint: pushEndpointOk, keys: { p256dh: 'x' } },
    { endpoint: pushEndpointOk, keys: {} },
    { endpoint: pushEndpointOk, keys: [] },
    { endpoint: pushEndpointOk, keys: null },
    { endpoint: pushEndpointOk },
    { endpoint: 5, keys: pushKeys },
    { keys: pushKeys },
    {},
  ].map((b) => JSON.stringify(b)),
  '',
  'null',
  '[]',
  '5',
  '{bad',
];
const unsubscribeRaw = [
  ...[
    { endpoint: pushEndpointOk },
    { endpoint: '' },
    { endpoint: 'x'.repeat(1000) },
    { endpoint: 'x'.repeat(1001) },
    { endpoint: null },
    {},
  ].map((b) => JSON.stringify(b)),
  '',
  '[]',
];
const pushEndpoints = [
  pushEndpointOk,
  'https://updates.push.services.mozilla.com/wpush/v2/synthetic',
  'https://web.push.apple.com/synthetic',
  'https://api.push.apple.com/3/device/synthetic',
  'https://wns2-db5p.notify.windows.com/w/?token=synthetic',
  'https://FCM.googleapis.com/fcm/send/synthetic',
  'https://fcm.googleapis.com:443/fcm/send/synthetic',
  'https://fcm.googleapis.com:8443/fcm/send/synthetic',
  'https://evil.example/fcm.googleapis.com',
  'http://fcm.googleapis.com/x',
  'https://169.254.169.254/latest',
  'https://user@fcm.googleapis.com/x',
  'https://user:pw@fcm.googleapis.com/x',
  'https://fcm.googleapis.com.evil.example/x',
  'https://a.b.push.apple.com/x',
  'https://a_b.push.apple.com/x',
  'https://notify.windows.com/x',
  `https://fcm.googleapis.com/${'x'.repeat(973)}`,
  `https://fcm.googleapis.com/${'x'.repeat(974)}`,
  'not a url',
  '',
];

// Rule validation after the schema (validateRule).
const known = new Set(['Alertas', 'Narrativas', 'Eventos', 'InteligenciaDigital']);
const channels = new Set([3]);
const ruleInput = (over) => ({
  name: 'R',
  enabled: true,
  module: 'Alertas',
  actions: ['CREATE'],
  conditions: [],
  steps: [{ kind: 'notify', title: 't' }],
  ...over,
});
const ruleInputs = [
  ruleInput({}),
  ruleInput({ module: '*' }),
  ruleInput({ module: 'Desconocido' }),
  ruleInput({ actions: ['BORRAR'] }),
  ruleInput({ actions: ['CREATE', 'CONFIG_UPDATE'] }),
  ruleInput({ conditions: [{ field: '$marking', op: 'eq', value: 'x' }] }),
  ruleInput({ conditions: [{ field: 'Año fiscal/2026.v-1', op: 'gte', value: '1' }] }),
  ruleInput({ conditions: [{ field: '$$a', op: 'eq', value: '' }] }),
  ruleInput({ conditions: [{ field: 'a$', op: 'eq', value: '' }] }),
  ruleInput({ conditions: [{ field: 'campo:x', op: 'eq', value: '' }] }),
  ruleInput({ conditions: [{ field: 'Ⅻ٣', op: 'eq', value: '' }] }),
  ruleInput({ conditions: [{ field: 'a\tb', op: 'eq', value: '' }] }),
  ruleInput({ conditions: [{ field: long(60, 'ñ'), op: 'eq', value: '' }] }),
  ruleInput({ conditions: [{ field: `$${long(60)}`, op: 'eq', value: '' }] }),
  ruleInput({ conditions: [{ field: long(31, '😀'), op: 'eq', value: '' }] }),
  ruleInput({ steps: [{ kind: 'notify', title: '   ' }] }),
  ruleInput({ steps: [{ kind: 'notify', title: '　' }] }),
  ruleInput({ steps: [{ kind: 'channel', channelId: 3, title: 't' }] }),
  ruleInput({ steps: [{ kind: 'channel', channelId: 4, title: 't' }] }),
  ruleInput({ steps: [{ kind: 'evaluate', minimumLevel: 'Media', title: 't' }] }),
  ruleInput({
    module: 'Narrativas',
    steps: [{ kind: 'evaluate', minimumLevel: 'Alta', title: 't' }],
  }),
  ruleInput({
    module: 'Narrativas',
    actions: ['CREATE', 'DELETE'],
    steps: [{ kind: 'evaluate', minimumLevel: 'Alta', title: 't' }],
  }),
];

const event = (over) => ({
  auditId: 7,
  at: new Date('2026-10-01T10:00:00.250Z'),
  module: 'Alertas',
  recordId: 'AL-1',
  action: 'CREATE',
  detail: 'Alerta creada',
  record: {
    payload: {
      Nivel: ' Alto ',
      Puntaje: 12,
      Monto: '1e3',
      Hex: '0x1F',
      Fecha: '2026-10-01',
      Activo: true,
      Lista: ['a', 2],
      Objeto: { b: 1, a: 'Ñ' },
      Vacio: '',
      Nulo: null,
      Turco: 'İSTANBUL',
      Sigma: 'ΟΔΟΣ',
      Emoji: '😀x',
      Privado: '',
      Espacio: ' 12 ',
      Grande: 1e21,
      Pequeno: 1.5e-7,
      Neg: -0,
    },
    marking: 'interno',
  },
  ...over,
});
const events = [
  event({}),
  event({ record: null, recordId: null, detail: '' }),
  event({ record: { payload: { Nivel: 'Alto' }, marking: 'restringido' } }),
  event({ module: 'Automatizaciones' }),
  event({ module: 'InteligenciaDigital', action: 'UPDATE' }),
];
const fields = [
  '$action',
  '$detail',
  '$module',
  '$marking',
  'Nivel',
  'Puntaje',
  'Monto',
  'Hex',
  'Fecha',
  'Activo',
  'Lista',
  'Objeto',
  'Vacio',
  'Nulo',
  'Falta',
  'Turco',
  'Sigma',
  'Emoji',
  'Privado',
  'Espacio',
  'Grande',
  'Pequeno',
  'Neg',
];
const values = [
  '',
  'alto',
  ' ALTO ',
  '12',
  '12.0',
  '011',
  '0x0c',
  '1000',
  '999',
  '2026-09-30',
  '2026-10-02',
  'true',
  'a',
  '["a",2]',
  '{"b":1,"a":"ñ"}',
  'i̇stanbul',
  'istanbul',
  'οδος',
  'οδοσ',
  '😀',
  '',
  ' 12 ',
  'Infinity',
  '1e21',
  '1.5e-7',
  '0',
  '-0',
  '.5',
  '5.',
  '+12',
  '0b1100',
  '0o14',
  '1_2',
  'NaN',
];
const ops = ['eq', 'neq', 'contains', 'gte', 'lte', 'present', 'absent'];
const conditions = [];
for (const [e, ev] of events.entries())
  for (const field of fields)
    for (const value of e === 0 ? values : ['', 'alto'])
      conditions.push({
        event: e,
        field,
        value,
        holds: ops.map((op) => (conditionHolds(ev, { field, op, value }) ? '1' : '0')).join(''),
      });

const rules = [
  { id: 1, name: 'r', enabled: true, module: '*', actions: ['CREATE'], conditions: [], steps: [] },
  { id: 1, name: 'r', enabled: false, module: '*', actions: ['CREATE'], conditions: [], steps: [] },
  {
    id: 1,
    name: 'r',
    enabled: true,
    module: 'Alertas',
    actions: ['UPDATE', 'CREATE'],
    conditions: [],
    steps: [],
  },
  {
    id: 1,
    name: 'r',
    enabled: true,
    module: 'Eventos',
    actions: ['CREATE'],
    conditions: [],
    steps: [],
  },
  {
    id: 1,
    name: 'r',
    enabled: true,
    module: '*',
    actions: ['CREATE', 'UPDATE'],
    conditions: [
      { field: 'Nivel', op: 'eq', value: 'alto' },
      { field: 'Puntaje', op: 'gte', value: '10' },
    ],
    steps: [],
  },
];
const matches = [];
for (const [e, ev] of events.entries())
  for (const [r, rl] of rules.entries())
    matches.push({ event: e, rule: r, matches: ruleMatches(rl, ev) });

const titles = [
  'Aviso {modulo} {id} {accion}',
  '{ modulo }/{Nivel}/{Puntaje}/{Activo}/{Lista}/{Objeto}/{Nulo}/{Falta}/{Grande}/{Pequeno}/{Neg}',
  '{{Nivel}} {} {Nivel {Nivel}}',
  `{${long(60)}} {${long(61)}}`,
  `{${long(29, '😀')}x} {${long(30, '😀')}} {${long(30, '😀')}x}`,
  `${long(199)}😀 tail`,
  `${long(198)}😀 tail`,
  'Línea\n{Nivel}\t$&$1',
  '{Emoji}{Turco}',
];
const rendered = [];
for (const [e, ev] of events.entries())
  for (const title of titles) rendered.push({ event: e, title, out: renderTitle(title, ev) });
const described = events.map((ev, e) => ({ event: e, out: describeEvent(ev) }));
const longDetail = event({ detail: `${long(470)}😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀` });
described.push({ event: -1, detail: longDetail.detail, out: describeEvent(longDetail) });

const channelSettings = [
  ['webhook', { url: 'https://hooks.example.org/a?b=1#frag', secret: ` ${long(24)} ` }],
  ['webhook', { url: 'https://HOOKS.Example.ORG:8443/a/../b', secret: long(24) }],
  ['webhook', { url: 'https://hooks.example.org', secret: long(23) }],
  ['webhook', { url: 'https://hooks.example.org', secret: long(201) }],
  ['webhook', { url: 'http://hooks.example.org', secret: long(24) }],
  ['webhook', { url: 'https://user:pw@hooks.example.org', secret: long(24) }],
  ['webhook', { url: 'notaurl', secret: long(24) }],
  ['webhook', { url: 'https://localhost/x', secret: long(24) }],
  ['webhook', { url: 'https://10.0.0.1/x', secret: long(24) }],
  ['webhook', { url: 'https://[::1]/x', secret: long(24) }],
  ['webhook', { url: 'https://intranet/x', secret: long(24) }],
  ['webhook', { url: 'https://svc.internal/x', secret: long(24) }],
  ['webhook', { url: 'https://100.64.0.1/x', secret: long(24) }],
  ['webhook', { url: 'https://8.8.8.8/x', secret: long(24) }],
  ['webhook', { url: `https://hooks.example.org/${long(980)}`, secret: long(24) }],
  ['slack', { url: 'https://hooks.slack.com/services/T0/B0/xyz' }],
  ['slack', { url: 'https://evil.example.org/services' }],
  ['discord', { url: 'https://discord.com/api/webhooks/1/abc' }],
  ['discord', { url: 'https://discordapp.com/api/webhooks/1/abc' }],
  ['gchat', { url: 'https://chat.googleapis.com/v1/spaces/x/messages?key=k' }],
  ['teams', { url: 'https://prod-00.westus.logic.azure.com/workflows/x' }],
  ['telegram', { bot_token: `123456:${long(35)}`, chat_id: '-1001234' }],
  ['telegram', { bot_token: `123456:${long(35)}`, chat_id: '@canal_sipges' }],
  ['telegram', { bot_token: 'bad', chat_id: '1' }],
  ['telegram', { bot_token: `123456:${long(35)}`, chat_id: '@abc' }],
  [
    'email',
    {
      api_key: `re_${long(12)}`,
      from: 'SIPGES <avisos@example.org>',
      to: 'uno@example.org, dos@example.org',
    },
  ],
  ['email', { api_key: `re_${long(12)}`, from: 'avisos@example.org', to: ['uno@example.org'] }],
  ['email', { api_key: `re_${long(12)}`, from: 'avisos@example.org', to: ['x'] }],
  ['email', { api_key: 'sk_x', from: 'avisos@example.org', to: ['uno@example.org'] }],
  ['email', { api_key: `re_${long(12)}`, from: 'avisos@example.org', to: '' }],
  [
    'email',
    { api_key: `re_${long(12)}`, from: 'avisos@example.org', to: [' ', 'tres@example.org'] },
  ],
];
const channelResults = channelSettings.map(([kind, settings]) => ({
  kind,
  settings,
  out: validateChannel(kind, settings),
}));
const hosts = [
  'localhost',
  'a.localhost',
  'x.local',
  'x.internal',
  '127.0.0.1',
  '172.16.0.1',
  '172.32.0.1',
  '192.168.1.1',
  '169.254.1.1',
  '0.1.2.3',
  '100.127.255.255',
  '100.128.0.1',
  '[::1]',
  '::',
  'fc00::1',
  'fe80::1',
  'feb0::1',
  'fec0::1',
  '::ffff:1.2.3.4',
  '2001:db8::1',
  'example',
  'example.org',
  'EXAMPLE.LOCAL',
  '999.1.1.1',
];
const privateHosts = hosts.map((host) => ({ host, private: isPrivateHost(host) }));

// Outbound requests of every channel kind, captured instead of sent.
const sent = [];
const sender = createHttpChannelSender(async (url, init) => {
  sent.push({ url, headers: init.headers, body: init.body });
  return new Response(null, { status: 204 });
});
const message = {
  id: 'msg_SIPGES_PRJ_SECHURA_42',
  title: 'Aviso <Alertas> & "equipo"',
  text: `CREATE en Alertas AL-1: Línea\u2028dos ${long(10, '😀')}`,
  tenantId: 'SIPGES/PRJ-SECHURA',
  at: new Date('2026-10-01T10:00:00.999Z'),
  event: {
    type: 'sipges.alertas.create',
    tenant: 'SIPGES/PRJ-SECHURA',
    audit_id: 7,
    at: '2026-10-01T10:00:00.250Z',
    module: 'Alertas',
    record_id: 'AL-1',
    action: 'CREATE',
    detail: 'Alerta creada',
    marking: 'interno',
    record: { b: 1, a: 'Ñ', 10: 'x', 2: [1.5, null, true] },
  },
};
const configs = [
  { kind: 'webhook', url: 'https://hooks.example.org/a', secret: long(24, 's') },
  { kind: 'slack', url: 'https://hooks.slack.com/services/x' },
  { kind: 'discord', url: 'https://discord.com/api/webhooks/1/x' },
  { kind: 'gchat', url: 'https://chat.googleapis.com/v1/x' },
  { kind: 'teams', url: 'https://prod.logic.azure.com/x' },
  { kind: 'telegram', botToken: `123456:${long(35)}`, chatId: '-100' },
  {
    kind: 'email',
    apiKey: `re_${long(12)}`,
    from: 'avisos@example.org',
    to: ['uno@example.org', 'dos@example.org'],
  },
];
for (const config of configs) await sender.send(config, message);
const longMessage = { ...message, title: long(1990), text: `${long(5000, '😀')}` };
for (const config of [configs[2], configs[5]]) await sender.send(config, longMessage);
const requests = sent.map((r, i) => {
  // Trace headers depend on the request context; none is active here.
  const headers = { ...r.headers };
  delete headers.traceparent;
  return {
    config: i < configs.length ? i : i === configs.length ? 2 : 5,
    long: i >= configs.length,
    url: r.url,
    headers,
    body: r.body,
  };
});

const fixture = {
  rule_bodies: ruleRaw.map((raw) => ({ raw, ...parse(RuleIn, raw) })),
  channel_bodies: channelRaw.map((raw) => ({ raw, ...parse(ChannelIn, raw) })),
  read_bodies: readRaw.map((raw) => ({ raw, ...parse(NotificationReadIn, raw) })),
  push_bodies: pushRaw.map((raw) => ({ raw, ...parse(PushSubscriptionIn, raw) })),
  unsubscribe_bodies: unsubscribeRaw.map((raw) => ({ raw, ...parse(PushUnsubscribeIn, raw) })),
  push_endpoints: pushEndpoints.map((endpoint) => ({ endpoint, ok: isPushEndpoint(endpoint) })),
  validate_rule: ruleInputs.map((input) => ({
    input,
    error: validateRule(input, known, channels),
  })),
  retry: [0, 1, 2, 3, 4, 5, 6].map((attempts) => ({
    attempts,
    minutes: retryDelayMinutes(attempts),
  })),
  events: events.map((e) => ({ ...e, at: e.at.toISOString() })),
  operators: ops,
  conditions,
  rules,
  matches,
  titles: rendered,
  described,
  channels: channelResults,
  private_hosts: privateHosts,
  message: { ...message, at: message.at.toISOString() },
  long_message: { title: longMessage.title, text: longMessage.text },
  configs,
  requests,
};
const text = await format(JSON.stringify(fixture), {
  ...(await resolveConfig(OUT)),
  parser: 'json',
});
if (process.argv.includes('--check')) {
  if (readFileSync(OUT, 'utf8') !== text) {
    console.error('fixtures.json drifted: rerun generate.mjs');
    process.exit(1);
  }
} else writeFileSync(OUT, text);
