// Public API of the Analytics context (docs/adr/0002).
export type { AnalyticsRecordReader } from './ports.ts';
export { createAnalyticsService, type AnalyticsService } from './analytics-service.ts';
