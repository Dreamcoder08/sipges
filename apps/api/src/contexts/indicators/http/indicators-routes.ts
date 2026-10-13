import { IrsaConfigUpdate, IrsaHistoryQuery, IrsaSnapshotCreate } from '@mascli/contracts';
import { Hono } from 'hono';
import type { AppEnv } from '../../../platform/http/env.ts';
import { parseJson } from '../../../platform/http/validation.ts';
import { formatScope } from '../../tenancy/application/index.ts';
import type { IndicatorsService } from '../application/index.ts';

/** Python `str(value or "")` for the snapshot note. */
const noteText = (value: unknown) => {
  if (value === undefined || value === null || value === false || value === 0 || value === '')
    return '';
  return typeof value === 'string' ? value : JSON.stringify(value);
};

/** Indicators & IRSA endpoints (app.py:1011-1062, 1657-1690). Role gates live in Identity. */
export const indicatorsRoutes = (deps: { indicators: IndicatorsService }) => {
  const { indicators } = deps;
  return new Hono<AppEnv>()
    .get('/system/irsa', async (c) => c.json(await indicators.irsa(formatScope(c.get('scope')))))

    .get('/system/irsa/config', async (c) =>
      c.json(await indicators.config(formatScope(c.get('scope')))),
    )

    .post('/system/irsa/config', async (c) => {
      const body = await parseJson(c, IrsaConfigUpdate);
      if (!body.ok) return body.response;
      const result = await indicators.updateConfig(formatScope(c.get('scope')), body.value.payload);
      if (!result.ok) return c.json({ detail: 'Los pesos deben sumar aproximadamente 1.' }, 400);
      return c.json({ ok: true, config: result.value });
    })

    .post('/system/irsa/snapshot', async (c) => {
      const body = await parseJson(c, IrsaSnapshotCreate);
      if (!body.ok) return body.response;
      const snapshot = await indicators.snapshot(
        formatScope(c.get('scope')),
        noteText(body.value.payload.note),
      );
      return c.json({ ok: true, ...snapshot });
    })

    .get('/system/irsa/history', async (c) => {
      const query = IrsaHistoryQuery.safeParse({ limit: c.req.query('limit') });
      if (!query.success) {
        return c.json(
          {
            detail: [
              {
                type: 'int_parsing',
                loc: ['query', 'limit'],
                msg: 'Input should be a valid integer, unable to parse string as an integer',
              },
            ],
          },
          422,
        );
      }
      const limit = query.data.limit < 0 ? null : query.data.limit;
      return c.json(await indicators.history(formatScope(c.get('scope')), limit));
    })

    .get('/system/indicators', async (c) =>
      c.json(await indicators.indicators(formatScope(c.get('scope')))),
    )

    .get('/system/model-status', (c) => c.json(indicators.modelStatus()))

    .get('/system/validation-template', (c) => c.json(indicators.validationTemplate()));
};
