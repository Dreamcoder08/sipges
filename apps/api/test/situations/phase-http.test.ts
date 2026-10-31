import { ProjectSettings } from '@mascli/contracts';
import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { createIndicatorsService } from '../../src/contexts/indicators/application/index.ts';
import { indicatorsRoutes } from '../../src/contexts/indicators/http/indicators-routes.ts';
import {
  createSqlIrsaConfigStore,
  createSqlIrsaSnapshotStore,
  createSqlModuleRecordReader,
} from '../../src/contexts/indicators/infrastructure/index.ts';
import { createSituationsService } from '../../src/contexts/situations/application/index.ts';
import { situationsRoutes } from '../../src/contexts/situations/http/situations-routes.ts';
import { createSqlProjectSettingsStore } from '../../src/contexts/situations/infrastructure/sql-project-settings-store.ts';
import { createSqlSituationRecordReader } from '../../src/contexts/situations/infrastructure/sql-situation-record-reader.ts';
import type { AppEnv } from '../../src/platform/http/env.ts';
import { createTestApp } from '../support/test-app.ts';

const OPERATION = { G: 0.1, A: 0.1, D: 0.1, N: 0.1, E: 0.5, I: 0.1 };

const setup = async () => {
  const t = await createTestApp();
  const situations = createSituationsService({
    settings: createSqlProjectSettingsStore(t.sql),
    records: createSqlSituationRecordReader(t.sql),
    clock: t.clock,
  });
  const indicators = createIndicatorsService({
    records: createSqlModuleRecordReader(t.sql),
    configs: createSqlIrsaConfigStore(t.sql),
    snapshots: createSqlIrsaSnapshotStore(t.sql),
    clock: t.clock,
    phaseWeights: { forTenant: situations.phaseWeights },
  });
  const app = new Hono<AppEnv>()
    .use('*', async (c, next) => {
      c.set('scope', { companyId: 'MASCLI', projectId: 'PRJ-SECHURA' });
      c.set('identity', { username: 'admin', fullName: 'Admin', role: 'admin' });
      await next();
    })
    .route('/', situationsRoutes(situations))
    .route('/', indicatorsRoutes({ indicators }));
  const put = (body: unknown) =>
    app.request('/system/v4/settings', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  const irsa = async () =>
    (await (await app.request('/system/irsa')).json()) as {
      irsa: number;
      weights: Record<string, number>;
      phase?: { id: string; label: string };
      notes: string[];
    };
  return { t, put, irsa };
};

describe('Project phase and phase IRSA weights (ADR 0021 §4)', () => {
  it('saves the phase and its weights, audited, and clears them with null', async () => {
    const { t, put } = await setup();
    const res = await put({ phase: 'operacion', phase_weights: { operacion: OPERATION } });
    expect(res.status).toBe(200);
    const saved = ProjectSettings.parse(await res.json());
    expect(saved.phase).toBe('operacion');
    expect(saved.phases.find((p) => p.id === 'operacion')?.weights).toEqual(OPERATION);
    expect(saved.phases.find((p) => p.id === 'cierre')?.weights).toBeNull();
    const cleared = ProjectSettings.parse(
      await (await put({ phase: null, phase_weights: { operacion: null } })).json(),
    );
    expect(cleared.phase).toBeNull();
    expect(cleared.phases.every((p) => p.weights === null)).toBe(true);
    expect(
      (
        await t.sql.query<{ detail: string }>(
          "SELECT detail FROM audit WHERE module = 'MASCLI 4.0' ORDER BY id",
        )
      ).map((r) => r.detail),
    ).toEqual([
      'Fase Operación; Campos: phase, phaseWeights',
      'Fase sin definir; Campos: phase, phaseWeights',
    ]);
  });

  it('rejects weights that do not sum to 1 and unknown phases', async () => {
    const { put } = await setup();
    expect((await put({ phase_weights: { operacion: { ...OPERATION, E: 0.9 } } })).status).toBe(
      422,
    );
    expect((await put({ phase: 'mantenimiento' })).status).toBe(422);
  });

  it('leaves IRSA unchanged until the phase has saved weights, then uses them', async () => {
    const { put, irsa } = await setup();
    const before = await irsa();
    expect(before.phase).toBeUndefined();
    await put({ phase: 'operacion' });
    expect(await irsa()).toEqual(before);
    await put({ phase_weights: { operacion: OPERATION } });
    const phased = await irsa();
    expect(phased.weights).toEqual(OPERATION);
    expect(phased.phase).toEqual({ id: 'operacion', label: 'Operación' });
    expect(phased.notes.at(-1)).toContain('Pesos de la fase Operación');
    await put({ phase_weights: { operacion: null } });
    expect(await irsa()).toEqual(before);
  });
});
