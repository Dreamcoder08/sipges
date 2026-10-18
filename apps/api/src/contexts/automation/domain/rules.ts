/** Rules over the audit event stream (docs/adr/0014 §1-2). Pure: no I/O. */

export const CONDITION_OPS = ['eq', 'neq', 'contains', 'gte', 'lte', 'present', 'absent'] as const;
export type ConditionOp = (typeof CONDITION_OPS)[number];

export type Condition = {
  readonly field: string;
  readonly op: ConditionOp;
  /** Ignored by `present` and `absent`. */
  readonly value: string;
};

export type RuleAction =
  | { readonly kind: 'evaluate'; readonly title: string; readonly minimumLevel: 'Media' | 'Alta' }
  | { readonly kind: 'notify'; readonly title: string }
  | { readonly kind: 'channel'; readonly channelId: number; readonly title: string };

export type Rule = {
  readonly id: number;
  readonly name: string;
  readonly enabled: boolean;
  /** Stored module name (e.g. `Alertas`, `Vinculos`) or `*` for every module. */
  readonly module: string;
  readonly actions: readonly string[];
  readonly conditions: readonly Condition[];
  readonly steps: readonly RuleAction[];
};

/** One audit row, with the current state of the record it names when there is one. */
export type AuditEvent = {
  readonly auditId: number;
  readonly at: Date;
  readonly module: string;
  readonly recordId: string | null;
  readonly action: string;
  readonly detail: string;
  readonly record: {
    readonly payload: Readonly<Record<string, unknown>>;
    readonly marking: string;
  } | null;
};

/** Audit module written by this context; its rows never trigger rules (no loops). */
export const AUTOMATION_AUDIT_MODULE = 'Automatizaciones';

export const RULE_LIMITS = {
  conditions: 10,
  steps: 5,
  actions: 10,
  text: 200,
} as const;

const normalize = (value: unknown): string =>
  value === null || value === undefined
    ? ''
    : typeof value === 'string'
      ? value.trim().toLocaleLowerCase('es')
      : typeof value === 'number' || typeof value === 'boolean'
        ? String(value).toLocaleLowerCase('es')
        : JSON.stringify(value).toLocaleLowerCase('es');

/** Numbers compare numerically; anything else (ISO dates included) compares as text. */
const compare = (left: string, right: string): number => {
  const a = Number(left);
  const b = Number(right);
  if (left !== '' && right !== '' && Number.isFinite(a) && Number.isFinite(b)) return a - b;
  return left < right ? -1 : left > right ? 1 : 0;
};

/** Event fields a condition may name besides record payload fields. */
const eventField = (event: AuditEvent, field: string): unknown => {
  if (field === '$action') return event.action;
  if (field === '$detail') return event.detail;
  if (field === '$module') return event.module;
  if (field === '$marking') return event.record?.marking;
  return event.record?.payload[field];
};

export const conditionHolds = (event: AuditEvent, condition: Condition): boolean => {
  const actual = normalize(eventField(event, condition.field));
  const expected = normalize(condition.value);
  switch (condition.op) {
    case 'present':
      return actual !== '';
    case 'absent':
      return actual === '';
    case 'eq':
      return actual === expected;
    case 'neq':
      return actual !== expected;
    case 'contains':
      return expected !== '' && actual.includes(expected);
    case 'gte':
      return actual !== '' && compare(actual, expected) >= 0;
    case 'lte':
      return actual !== '' && compare(actual, expected) <= 0;
  }
};

export const ruleMatches = (rule: Rule, event: AuditEvent): boolean =>
  rule.enabled &&
  event.module !== AUTOMATION_AUDIT_MODULE &&
  (rule.module === '*' || rule.module === event.module) &&
  rule.actions.includes(event.action) &&
  rule.conditions.every((condition) => conditionHolds(event, condition));

export const MAX_ATTEMPTS = 5;

/** Minutes to wait after the n-th failed attempt (1, 4, 16, 64), or null when exhausted. */
export const retryDelayMinutes = (attempts: number): number | null =>
  attempts >= MAX_ATTEMPTS ? null : 4 ** Math.max(0, attempts - 1);

/** `{Campo}` placeholders in a title take values from the event; restricted records stay opaque. */
export const renderTitle = (template: string, event: AuditEvent): string =>
  template
    .replace(/\{([^{}]{1,60})\}/g, (_, name: string) => {
      const key = name.trim();
      if (key === 'modulo') return event.module;
      if (key === 'id') return event.recordId ?? '';
      if (key === 'accion') return event.action;
      if (event.record?.marking === 'restringido') return '[restringido]';
      const value = event.record?.payload[key];
      return value === undefined || value === null ? '' : normalizeDisplay(value);
    })
    .slice(0, RULE_LIMITS.text);

const normalizeDisplay = (value: unknown) =>
  typeof value === 'string'
    ? value
    : typeof value === 'object'
      ? JSON.stringify(value)
      : String(value);

/** One-paragraph description of the event for channels and the inbox. */
export const describeEvent = (event: AuditEvent): string => {
  const subject = event.recordId ? `${event.module} ${event.recordId}` : event.module;
  const detail = event.record?.marking === 'restringido' ? '' : event.detail;
  return `${event.action} en ${subject}${detail ? `: ${detail}` : ''}`.slice(0, 500);
};

export const EVENT_ACTIONS = [
  'CREATE',
  'UPDATE',
  'DELETE',
  'IMPORT',
  'UPLOAD',
  'CLASSIFY',
  'REVIEW',
  'SNAPSHOT',
  'CONFIG_UPDATE',
] as const;

/** Audit modules written outside the records context, with a label for the screen. */
export const SYSTEM_EVENT_SOURCES = [
  { module: 'InteligenciaDigital', label: 'Alertas de inteligencia digital' },
  { module: 'PrevencionTerritorial', label: 'Acciones de prevención' },
  { module: 'Vinculos', label: 'Vínculos entre registros' },
  { module: 'Laboratorio_Documental', label: 'Laboratorio documental' },
  { module: 'IRSA', label: 'Indicador IRSA' },
  { module: 'Analista', label: 'Propuestas del analista' },
] as const;

export type RuleInput = {
  readonly name: string;
  readonly enabled: boolean;
  readonly module: string;
  readonly actions: readonly string[];
  readonly conditions: readonly Condition[];
  readonly steps: readonly RuleAction[];
};

export type RuleError = 'invalid_module' | 'invalid_action' | 'invalid_condition' | 'invalid_step';

/** Checks a rule against the known event sources; `channels` are the tenant's channel ids. */
export const validateRule = (
  input: RuleInput,
  knownModules: ReadonlySet<string>,
  channels: ReadonlySet<number>,
): RuleError | null => {
  if (input.module !== '*' && !knownModules.has(input.module)) return 'invalid_module';
  if (
    input.actions.length === 0 ||
    input.actions.length > RULE_LIMITS.actions ||
    !input.actions.every((a) => (EVENT_ACTIONS as readonly string[]).includes(a))
  )
    return 'invalid_action';
  if (
    input.conditions.length > RULE_LIMITS.conditions ||
    !input.conditions.every(
      (c) =>
        /^\$?[\p{L}\p{N}_ /.-]{1,60}$/u.test(c.field) &&
        (CONDITION_OPS as readonly string[]).includes(c.op) &&
        c.value.length <= RULE_LIMITS.text,
    )
  )
    return 'invalid_condition';
  if (
    input.steps.length === 0 ||
    input.steps.length > RULE_LIMITS.steps ||
    !input.steps.every(
      (s) =>
        s.title.trim().length > 0 &&
        s.title.length <= RULE_LIMITS.text &&
        (s.kind === 'notify' ||
          (s.kind === 'evaluate' &&
            input.module === 'Narrativas' &&
            input.actions.every((a) => a === 'CREATE' || a === 'UPDATE') &&
            (s.minimumLevel === 'Media' || s.minimumLevel === 'Alta')) ||
          (s.kind === 'channel' && channels.has(s.channelId))),
    )
  )
    return 'invalid_step';
  return null;
};
