import { z } from 'zod';

/** Automation rules, channels, runs and the notification inbox (docs/adr/0014). */

const Text = (max: number) =>
  z
    .string()
    .max(max)
    .refine((v) => !v.includes('\u0000'), { message: 'Text must not contain NUL characters' });

export const ConditionIn = z.object({
  field: Text(60).min(1),
  op: z.enum(['eq', 'neq', 'contains', 'gte', 'lte', 'present', 'absent']),
  value: Text(200).default(''),
});
export type ConditionIn = z.infer<typeof ConditionIn>;

export const RuleStepIn = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('notify'), title: Text(200).min(1) }),
  z.object({
    kind: z.literal('channel'),
    channel_id: z.number().int().positive(),
    title: Text(200).min(1),
  }),
]);
export type RuleStepIn = z.infer<typeof RuleStepIn>;

/** POST /system/automations/rules and PUT /system/automations/rules/{id}. */
export const RuleIn = z.object({
  name: Text(80).trim().min(1),
  enabled: z.boolean().default(true),
  module: Text(60).min(1),
  actions: z.array(Text(20)).min(1).max(10),
  conditions: z.array(ConditionIn).max(10).default([]),
  steps: z.array(RuleStepIn).min(1).max(5),
});
export type RuleIn = z.infer<typeof RuleIn>;

export const RuleOut = z.object({
  id: z.number().int(),
  name: z.string(),
  enabled: z.boolean(),
  module: z.string(),
  actions: z.array(z.string()),
  conditions: z.array(ConditionIn),
  steps: z.array(RuleStepIn),
  created_by: z.string(),
  updated_at: z.string(),
});
export type RuleOut = z.infer<typeof RuleOut>;

export const ChannelKind = z.enum([
  'webhook',
  'slack',
  'teams',
  'discord',
  'gchat',
  'telegram',
  'email',
]);
export type ChannelKind = z.infer<typeof ChannelKind>;

/** POST /system/automations/channels. Settings are write-only. */
export const ChannelIn = z.object({
  kind: ChannelKind,
  name: Text(80).trim().min(1),
  settings: z.record(z.string(), z.union([Text(1000), z.array(Text(200)).max(20)])),
});
export type ChannelIn = z.infer<typeof ChannelIn>;

export const ChannelOut = z.object({
  id: z.number().int(),
  kind: ChannelKind,
  name: z.string(),
  target_hint: z.string(),
  created_by: z.string(),
  created_at: z.string(),
});
export type ChannelOut = z.infer<typeof ChannelOut>;

export const AutomationEventOut = z.object({
  audit_id: z.number().int(),
  at: z.string(),
  module: z.string(),
  record_id: z.string().nullable(),
  action: z.string(),
  detail: z.string(),
});

export const RunOut = z.object({
  id: z.number().int(),
  rule_id: z.number().int(),
  rule_name: z.string(),
  kind: z.string(),
  status: z.enum(['pending', 'done', 'failed']),
  attempts: z.number().int(),
  last_error: z.string(),
  event: AutomationEventOut,
  created_at: z.string(),
  finished_at: z.string().nullable(),
  next_attempt_at: z.string(),
});
export type RunOut = z.infer<typeof RunOut>;

/** GET /system/automations: everything the screen needs in one call. */
export const AutomationOverview = z.object({
  sources: z.array(z.object({ module: z.string(), label: z.string() })),
  actions: z.array(z.string()),
  operators: z.array(z.string()),
  rules: z.array(RuleOut),
  channels: z.array(ChannelOut),
  runs: z.array(RunOut),
});
export type AutomationOverview = z.infer<typeof AutomationOverview>;

export const TickReport = z.object({
  tenants: z.number().int(),
  scanned: z.number().int(),
  queued: z.number().int(),
  delivered: z.number().int(),
  retrying: z.number().int(),
  failed: z.number().int(),
});
export type TickReport = z.infer<typeof TickReport>;

export const NotificationOut = z.object({
  id: z.number().int(),
  title: z.string(),
  body: z.string(),
  module: z.string().nullable(),
  record_id: z.string().nullable(),
  /** The record's 360° view when the notification names a records module. */
  link: z.object({ module: z.string(), id: z.string() }).nullable(),
  created_at: z.string(),
  read: z.boolean(),
});
export type NotificationOut = z.infer<typeof NotificationOut>;

/** GET /system/notifications. */
export const NotificationInbox = z.object({
  unread: z.number().int(),
  items: z.array(NotificationOut),
});
export type NotificationInbox = z.infer<typeof NotificationInbox>;

/** POST /system/notifications/read: listed ids, or every notification with `all`. */
export const NotificationReadIn = z.union([
  z.object({ ids: z.array(z.number().int().positive()).min(1).max(200) }),
  z.object({ all: z.literal(true) }),
]);
export type NotificationReadIn = z.infer<typeof NotificationReadIn>;

/** GET /system/notifications/push: whether device notifications are available. */
export const PushConfig = z.object({ enabled: z.boolean(), public_key: z.string().nullable() });
export type PushConfig = z.infer<typeof PushConfig>;

/** The browser's PushSubscription.toJSON(). */
export const PushSubscriptionIn = z.object({
  endpoint: z.string().max(1000),
  keys: z.object({ p256dh: z.string().max(200), auth: z.string().max(100) }),
});
export type PushSubscriptionIn = z.infer<typeof PushSubscriptionIn>;

export const PushUnsubscribeIn = z.object({ endpoint: z.string().max(1000) });
