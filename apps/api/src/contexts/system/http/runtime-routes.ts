import { Hono } from 'hono';
import type { AppEnv } from '../../../platform/http/env.ts';
import type { AutomationRuntime } from '../application/index.ts';
import { formatScope } from '../../tenancy/application/index.ts';
export const runtimeRoutes = (
  runtime: AutomationRuntime,
  config: {
    eventProcessing: boolean;
    cronConfigured: boolean;
    cronSchedule?: string | undefined;
    intervalMs: number;
  },
) =>
  new Hono<AppEnv>().get('/system/automations/runtime', async (c) => {
    const state = await runtime.state(formatScope(c.get('scope')));
    return c.json({
      event_processing: config.eventProcessing,
      cron_configured: config.cronConfigured,
      cron_schedule: config.cronSchedule ?? null,
      interval_ms: config.intervalMs,
      latest_attempt: state
        ? {
            started_at: state.startedAt.toISOString(),
            finished_at: state.finishedAt?.toISOString() ?? null,
            source: state.source,
            status: state.status,
            error: state.error,
            report: state.report,
          }
        : null,
    });
  });
