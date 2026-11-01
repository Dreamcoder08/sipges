import { describe, expect, it } from 'vitest';
import { planRuns } from '../../src/contexts/automation/application/index.ts';
import { isPrivateHost, validateChannel } from '../../src/contexts/automation/domain/channels.ts';
import {
  type AuditEvent,
  type Rule,
  conditionHolds,
  renderTitle,
  retryDelayMinutes,
  ruleMatches,
  validateRule,
} from '../../src/contexts/automation/domain/rules.ts';
import { signWebhook } from '../../src/contexts/automation/infrastructure/index.ts';

const event = (overrides: Partial<AuditEvent> = {}): AuditEvent => ({
  auditId: 7,
  at: new Date('2026-10-14T10:00:00Z'),
  module: 'Alertas',
  recordId: 'AL-1',
  action: 'CREATE',
  detail: 'Registro creado',
  record: { payload: { Nivel: 'Alto', Puntaje: 82, Fecha: '2026-10-14' }, marking: 'interno' },
  ...overrides,
});

const rule = (overrides: Partial<Rule> = {}): Rule => ({
  id: 1,
  name: 'Alertas altas',
  enabled: true,
  module: 'Alertas',
  actions: ['CREATE', 'UPDATE'],
  conditions: [{ field: 'Nivel', op: 'eq', value: 'alto' }],
  steps: [{ kind: 'notify', title: 'Alerta {ID_Alerta}' }],
  ...overrides,
});

describe('automation rules', () => {
  it('matches module, action and every condition', () => {
    expect(ruleMatches(rule(), event())).toBe(true);
    expect(ruleMatches(rule({ module: '*' }), event())).toBe(true);
    expect(ruleMatches(rule({ enabled: false }), event())).toBe(false);
    expect(ruleMatches(rule(), event({ module: 'Eventos' }))).toBe(false);
    expect(ruleMatches(rule(), event({ action: 'DELETE' }))).toBe(false);
    expect(
      ruleMatches(rule(), event({ record: { payload: { Nivel: 'Bajo' }, marking: 'interno' } })),
    ).toBe(false);
  });

  it('never matches its own audit rows, so rules cannot loop', () => {
    expect(ruleMatches(rule({ module: '*' }), event({ module: 'Automatizaciones' }))).toBe(false);
  });

  it('evaluates every operator, numbers numerically and dates as text', () => {
    const e = event();
    expect(conditionHolds(e, { field: 'Puntaje', op: 'gte', value: '80' })).toBe(true);
    expect(conditionHolds(e, { field: 'Puntaje', op: 'lte', value: '9' })).toBe(false);
    expect(conditionHolds(e, { field: 'Fecha', op: 'gte', value: '2026-10-01' })).toBe(true);
    expect(conditionHolds(e, { field: 'Nivel', op: 'contains', value: 'ALT' })).toBe(true);
    expect(conditionHolds(e, { field: 'Nivel', op: 'neq', value: 'alto' })).toBe(false);
    expect(conditionHolds(e, { field: 'Responsable', op: 'absent', value: '' })).toBe(true);
    expect(conditionHolds(e, { field: 'Nivel', op: 'present', value: '' })).toBe(true);
    expect(conditionHolds(e, { field: '$action', op: 'eq', value: 'create' })).toBe(true);
    expect(conditionHolds(e, { field: 'Responsable', op: 'gte', value: '' })).toBe(false);
  });

  it('plans one run per step of every matching rule', () => {
    const runs = planRuns(
      [event(), event({ auditId: 8, action: 'DELETE' })],
      [
        rule({
          steps: [
            { kind: 'notify', title: 'a' },
            { kind: 'channel', channelId: 3, title: 'b' },
          ],
        }),
        rule({ id: 2, module: 'Eventos' }),
      ],
    );
    expect(runs.map((r) => [r.ruleId, r.auditId, r.actionIndex, r.kind])).toEqual([
      [1, 7, 0, 'notify'],
      [1, 7, 1, 'channel'],
    ]);
  });

  it('renders titles without leaking restricted values', () => {
    expect(renderTitle('Alerta {ID_Alerta} {Nivel} en {modulo}', event())).toBe(
      'Alerta  Alto en Alertas',
    );
    expect(
      renderTitle(
        'Nivel {Nivel} de {id}',
        event({ record: { payload: { Nivel: 'Alto' }, marking: 'restringido' } }),
      ),
    ).toBe('Nivel [restringido] de AL-1');
  });

  it('backs off 1, 4, 16, 64 minutes and gives up after five attempts', () => {
    expect([1, 2, 3, 4, 5].map(retryDelayMinutes)).toEqual([1, 4, 16, 64, null]);
  });

  it('validates sources, actions, conditions and channel references', () => {
    const modules = new Set(['Alertas']);
    const input = { ...rule(), steps: [{ kind: 'channel' as const, channelId: 9, title: 'x' }] };
    expect(validateRule(input, modules, new Set([9]))).toBeNull();
    expect(validateRule(input, modules, new Set())).toBe('invalid_step');
    expect(validateRule({ ...input, module: 'Planetas' }, modules, new Set([9]))).toBe(
      'invalid_module',
    );
    expect(validateRule({ ...input, actions: ['DROP'] }, modules, new Set([9]))).toBe(
      'invalid_action',
    );
  });
});

describe('automation channels', () => {
  it('refuses local and private destinations', () => {
    for (const host of [
      'localhost',
      '127.0.0.1',
      '10.1.2.3',
      '192.168.0.4',
      '169.254.169.254',
      '[::1]',
      'intranet',
      'api.internal',
    ])
      expect(isPrivateHost(host), host).toBe(true);
    expect(isPrivateHost('hooks.slack.com')).toBe(false);
    expect(validateChannel('webhook', { url: 'https://10.0.0.1/x', secret: 'x'.repeat(32) })).toBe(
      'private_host',
    );
    expect(
      validateChannel('webhook', { url: 'http://example.org/x', secret: 'x'.repeat(32) }),
    ).toBe('invalid_url');
  });

  it('pins chat services to their own hosts and masks e-mail recipients', () => {
    expect(validateChannel('slack', { url: 'https://example.org/hook' })).toBe('wrong_host');
    expect(
      validateChannel('slack', { url: 'https://hooks.slack.com/services/T/B/x' }),
    ).toMatchObject({
      targetHint: 'hooks.slack.com',
    });
    expect(
      validateChannel('email', {
        api_key: 're_synthetic_key_123',
        from: 'SIPGES <avisos@example.org>',
        to: 'ana@example.org, luis@example.org',
      }),
    ).toMatchObject({ targetHint: 'an…@example.org y 1 más' });
    expect(validateChannel('telegram', { bot_token: 'nope', chat_id: '1' })).toBe(
      'invalid_settings',
    );
  });

  it('signs webhooks the Standard Webhooks way', () => {
    // Reference value computed independently: HMAC-SHA256("secret", "msg_1.1700000000.{}").
    expect(signWebhook('secret', 'msg_1', 1_700_000_000, '{}')).toBe(
      'v1,A5oIrJxXPB/PkULSoVu0e4khvPiqpF9vljmhkSKg0FI=',
    );
  });
});

describe('narrative evaluation guards', () => {
  it('requires an explicit narrative CREATE/UPDATE source', () => {
    const input = rule({
      module: 'Narrativas',
      conditions: [],
      steps: [{ kind: 'evaluate', title: 'Evaluar', minimumLevel: 'Media' }],
    });
    const modules = new Set(['Narrativas', 'InteligenciaDigital']);
    expect(validateRule(input, modules, new Set())).toBeNull();
    for (const module of ['*', 'InteligenciaDigital'])
      expect(validateRule({ ...input, module }, modules, new Set())).toBe('invalid_step');
    expect(validateRule({ ...input, actions: ['REVIEW'] }, modules, new Set())).toBe(
      'invalid_step',
    );
  });
});
