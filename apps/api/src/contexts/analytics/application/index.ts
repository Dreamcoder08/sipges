// Public API of the Analytics context (docs/adr/0002).
export type { AnalyticsRecordReader, ReportRenderer } from './ports.ts';
export {
  createAnalyticsService,
  type AnalyticsReport,
  type AnalyticsService,
} from './analytics-service.ts';
