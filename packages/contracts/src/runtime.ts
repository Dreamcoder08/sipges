import { z } from 'zod';
export const AutomationRuntimeState = z.object({
  event_processing: z.boolean(),
  cron_configured: z.boolean(),
  cron_schedule: z.string().nullable(),
  interval_ms: z.number(),
  latest_attempt: z
    .object({
      started_at: z.string(),
      finished_at: z.string().nullable(),
      source: z.enum(['event', 'cron']),
      status: z.enum(['running', 'completed', 'failed']),
      error: z.string(),
      report: z
        .object({
          tenants: z.number(),
          scanned: z.number(),
          queued: z.number(),
          delivered: z.number(),
          retrying: z.number(),
          failed: z.number(),
        })
        .nullable(),
    })
    .nullable(),
});
