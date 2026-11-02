// Public API of the Analytics context (docs/adr/0002).
export type { AnalyticsRecordReader, ConflictRiskSources, ReportRenderer } from './ports.ts';
export {
  createAnalyticsService,
  type AnalyticsReport,
  type AnalyticsService,
} from './analytics-service.ts';
export { createConflictRiskService, type ConflictRiskService } from './conflict-risk-service.ts';
export type {
  ConflictRiskReport,
  IrsaPoint,
  RiskAlert,
  RiskRecord,
} from '../domain/conflict-risk/index.ts';
