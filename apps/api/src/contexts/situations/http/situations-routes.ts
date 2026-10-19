import { ProjectSettingsIn } from '@mascli/contracts';
import { Hono } from 'hono';
import type { AppEnv } from '../../../platform/http/env.ts';
import { parseJson } from '../../../platform/http/validation.ts';
import type { ProjectSettings, SituationsService } from '../application/index.ts';

/** MASCLI 4.0 endpoints (docs/adr/0020). Writing settings is admin-only (Identity). */
export const situationsRoutes = (situations: SituationsService) => {
  const settingsJson = (s: ProjectSettings) => ({
    version4: s.version4,
    level_meanings: s.levelMeanings,
    window_days: s.windowDays,
    half_life_days: s.halfLifeDays,
    thresholds: s.thresholds,
    recommendations: situations.recommendationCatalogue(s),
    updated_by: s.updatedBy,
    updated_at: s.updatedAt?.toISOString() ?? null,
  });
  return new Hono<AppEnv>()
    .get('/system/v4/settings', async (c) =>
      c.json(settingsJson(await situations.settings(c.get('scope')))),
    )
    .put('/system/v4/settings', async (c) => {
      const body = await parseJson(c, ProjectSettingsIn);
      if (!body.ok) return body.response;
      const { version4, level_meanings, window_days, half_life_days, thresholds, recommendations } =
        body.value;
      const saved = await situations.updateSettings(
        c.get('scope'),
        {
          version4,
          levelMeanings: level_meanings,
          windowDays: window_days,
          halfLifeDays: half_life_days,
          thresholds,
          recommendations,
        },
        c.get('identity').username,
      );
      return c.json(settingsJson(saved));
    })
    .get('/system/v4/situations', async (c) => {
      const report = await situations.situations(c.get('scope'));
      return c.json({
        generated_at: report.generatedAt.toISOString(),
        today: report.today,
        window_days: report.windowDays,
        considered: report.considered,
        undated: report.undated,
        situations: report.situations.map(({ lastDate, ...s }) => ({ ...s, last_date: lastDate })),
        narratives: report.narratives,
        method: report.method,
        limitations: report.limitations,
      });
    });
};
