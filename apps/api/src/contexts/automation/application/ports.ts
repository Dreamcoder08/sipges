import type { ChannelConfig, ChannelKind } from '../domain/channels.ts';
import type { AuditEvent, Rule, RuleInput } from '../domain/rules.ts';

export type StoredRule = Rule & {
  readonly createdBy: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
};

export type StoredChannel = {
  readonly id: number;
  readonly kind: ChannelKind;
  readonly name: string;
  readonly targetHint: string;
  readonly createdBy: string;
  readonly createdAt: Date;
};

/** A run to insert for a matched event; unique on (rule, audit row, action index). */
export type NewRun = {
  readonly ruleId: number;
  readonly auditId: number;
  readonly actionIndex: number;
  readonly kind: string;
  readonly event: AuditEvent;
};

/** A claimed run, with the rule step it executes (null when the rule changed since). */
export type ClaimedRun = {
  readonly id: number;
  readonly ruleId: number;
  readonly ruleName: string;
  readonly attempts: number;
  readonly event: AuditEvent;
  readonly step: Rule['steps'][number] | null;
};

export type RunStatus = 'pending' | 'done' | 'failed';

export type RunView = {
  readonly id: number;
  readonly ruleId: number;
  readonly ruleName: string;
  readonly kind: string;
  readonly status: RunStatus;
  readonly attempts: number;
  readonly lastError: string;
  readonly event: AuditEvent;
  readonly createdAt: Date;
  readonly finishedAt: Date | null;
  readonly nextAttemptAt: Date;
};

export type NotificationView = {
  readonly id: number;
  readonly title: string;
  readonly body: string;
  readonly module: string | null;
  readonly recordId: string | null;
  readonly createdAt: Date;
  readonly read: boolean;
};

export type NotificationInbox = {
  readonly unread: number;
  readonly items: NotificationView[];
};

export type NewNotification = {
  readonly runId?: number;
  readonly title: string;
  readonly body: string;
  readonly module: string | null;
  readonly recordId: string | null;
  readonly marking: string;
  readonly ruleId: number | null;
};

/** Every tenant-scoped call runs in one tenant transaction (docs/adr/0003). */
export type AutomationStore = {
  /** Every tenant that ever had a rule (global read of the cursors, outside any tenant). */
  activeTenants(): Promise<string[]>;
  rules(tenantId: string): Promise<StoredRule[]>;
  /**
   * Inserts or updates a rule and audits it; the first rule of a tenant starts the cursor at
   * the newest audit row, so history never fires.
   */
  saveRule(
    tenantId: string,
    id: number | null,
    rule: RuleInput,
    actor: string,
    at: Date,
  ): Promise<{ ok: true; id: number } | { ok: false; error: 'missing' | 'duplicate' }>;
  deleteRule(tenantId: string, id: number, at: Date): Promise<boolean>;

  channels(tenantId: string): Promise<StoredChannel[]>;
  createChannel(
    tenantId: string,
    channel: { kind: ChannelKind; name: string; targetHint: string; sealed: string },
    actor: string,
    at: Date,
  ): Promise<{ ok: true; id: number } | { ok: false; error: 'duplicate' }>;
  /** Refuses (in_use) while an enabled rule still sends to the channel. */
  deleteChannel(tenantId: string, id: number, at: Date): Promise<'deleted' | 'missing' | 'in_use'>;
  sealedChannel(tenantId: string, id: number): Promise<string | null>;

  /**
   * One transaction holding the tenant cursor: reads up to `limit` audit rows after it with the
   * current state of their records, asks `plan` for runs, inserts them and moves the cursor.
   */
  scan(
    tenantId: string,
    limit: number,
    plan: (events: readonly AuditEvent[], rules: readonly Rule[]) => readonly NewRun[],
    at: Date,
  ): Promise<{ scanned: number; queued: number }>;
  /** Leases due pending runs until `leaseUntil` and counts the attempt. */
  claimDue(tenantId: string, limit: number, at: Date, leaseUntil: Date): Promise<ClaimedRun[]>;
  finishRun(
    tenantId: string,
    id: number,
    outcome: { status: 'done' } | { status: 'pending' | 'failed'; error: string; retryAt: Date },
    at: Date,
  ): Promise<void>;
  runs(tenantId: string, limit: number): Promise<RunView[]>;

  notify(tenantId: string, notification: NewNotification, at: Date): Promise<number>;
  /** The user's unread count and latest notifications, read together in one transaction. */
  inbox(tenantId: string, username: string, limit: number): Promise<NotificationInbox>;
  markRead(
    tenantId: string,
    username: string,
    ids: readonly number[] | 'all',
    at: Date,
  ): Promise<void>;
};

/** A message as every channel adapter receives it. */
export type OutboundMessage = {
  /** Stable per run, so receivers can de-duplicate retries. */
  readonly id: string;
  readonly title: string;
  readonly text: string;
  readonly tenantId: string;
  readonly at: Date;
  /** Machine-readable event for generic webhooks; restricted records carry no payload. */
  readonly event: Readonly<Record<string, unknown>>;
};

export type ChannelSender = {
  send(config: ChannelConfig, message: OutboundMessage): Promise<void>;
};

export type SecretSealer = {
  seal(plaintext: string): string;
  open(sealed: string): string;
};

export type PushSubscription = {
  readonly endpoint: string;
  readonly p256dh: string;
  readonly auth: string;
};

/** What the service worker shows; `url` opens on click. */
export type PushPayload = { readonly title: string; readonly body: string; readonly url: string };

export type PushSender = {
  readonly publicKey: string;
  send(subscription: PushSubscription, payload: PushPayload, now: Date): Promise<'sent' | 'gone'>;
};

/** Global, per person and device (like sessions). */
export type PushStore = {
  save(username: string, subscription: PushSubscription, at: Date): Promise<void>;
  remove(username: string, endpoint: string): Promise<void>;
  /** Subscriptions of active people granted the tenant; restricted pushes skip `consulta`. */
  targets(tenantId: string, restricted: boolean): Promise<PushSubscription[]>;
  forget(endpoint: string): Promise<void>;
  ownTargets?(username: string): Promise<PushSubscription[]>;
  enqueue?(
    tenantId: string,
    notificationId: number,
    restricted: boolean,
    payload: PushPayload,
    at: Date,
  ): Promise<void>;
  claim?(
    tenantId: string,
    at: Date,
    leaseUntil: Date,
  ): Promise<
    { id: number; subscription: PushSubscription; payload: PushPayload; attempts: number }[]
  >;
  finish?(
    tenantId: string,
    id: number,
    status: 'accepted' | 'failed' | 'pending',
    error: string,
    retryAt: Date,
  ): Promise<void>;
};

/** One audit row per outbound send; the detail names kinds and internal ids, never targets. */
export type SendAuditEntry = {
  readonly module: string;
  readonly recordId: null;
  readonly action: 'CHANNEL_SEND' | 'PUSH_SEND';
  readonly detail: string;
  readonly at: Date;
};

/** Write side of the tenant audit trail, provided by the Audit context (docs/adr/0002). */
export type SendAudit = {
  append(tenantId: string, entry: SendAuditEntry): Promise<void>;
};

export type Clock = { now(): Date };
