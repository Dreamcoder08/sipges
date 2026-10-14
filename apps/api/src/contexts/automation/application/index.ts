// Public API of the Automation context (docs/adr/0014).
export {
  CHANNEL_KINDS,
  type ChannelConfig,
  type ChannelError,
  type ChannelKind,
  isChannelKind,
  isPrivateHost,
} from '../domain/channels.ts';
export {
  AUTOMATION_AUDIT_MODULE,
  CONDITION_OPS,
  EVENT_ACTIONS,
  type AuditEvent,
  type Condition,
  type Rule,
  type RuleAction,
  type RuleError,
  type RuleInput,
} from '../domain/rules.ts';
export type {
  AutomationStore,
  ChannelSender,
  NotificationView,
  OutboundMessage,
  RunView,
  SecretSealer,
  StoredChannel,
  StoredRule,
} from './ports.ts';
export {
  type AutomationService,
  type EventSource,
  type TickReport,
  createAutomationService,
  planRuns,
} from './automation-service.ts';
