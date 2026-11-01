import { type Result, err, ok } from '@sipges/kernel';
import {
  DEFAULT_IRSA_CONFIG,
  INDICATOR_CONFIG,
  type IndicatorsReport,
  type IrsaConfig,
  type IrsaConfigError,
  type IrsaConfigPatch,
  type IrsaResult,
  MODEL_STATUS,
  applyIrsaConfigPatch,
  computeIndicators,
  computeIrsa,
  pyFloat,
} from '../domain/index.ts';
import type {
  Clock,
  IrsaConfigStore,
  IrsaSnapshot,
  IrsaSnapshotStore,
  ModuleRecordReader,
  PhaseWeightsSource,
} from './ports.ts';

export type ValidationTemplate = {
  readonly status: 'PENDIENTE';
  readonly rows: readonly Record<string, string | null>[];
};

const validationTemplate = (): ValidationTemplate => ({
  status: 'PENDIENTE',
  rows: Object.entries(INDICATOR_CONFIG).flatMap(([dimension, items]) =>
    items.map((item) => ({
      dimension,
      code: item.code,
      name: item.name,
      definition: item.definition,
      expert_1: null,
      expert_2: null,
      expert_3: null,
      expert_4: null,
      expert_5: null,
      aiken_v: null,
      decision: 'Pendiente',
    })),
  ),
});

/** Use cases of the Indicators & IRSA context (app.py:1004-1062, 1619-1690). */
export const createIndicatorsService = (deps: {
  records: ModuleRecordReader;
  configs: IrsaConfigStore;
  snapshots: IrsaSnapshotStore;
  clock: Clock;
  phaseWeights?: PhaseWeightsSource;
}) => {
  const config = async (tenantId: string): Promise<IrsaConfig> =>
    (await deps.configs.load(tenantId)) ?? DEFAULT_IRSA_CONFIG;
  const indicators = async (tenantId: string): Promise<IndicatorsReport> =>
    computeIndicators(await deps.records.read(tenantId));
  const irsa = async (
    tenantId: string,
  ): Promise<IrsaResult & { phase?: { id: string; label: string } }> => {
    const [cfg, report, phase] = await Promise.all([
      config(tenantId),
      indicators(tenantId),
      deps.phaseWeights?.forTenant(tenantId) ?? null,
    ]);
    if (!phase) return computeIrsa(cfg, report);
    const result = computeIrsa({ ...cfg, weights: { ...phase.weights } }, report);
    return {
      ...result,
      phase: { id: phase.phase, label: phase.label },
      notes: [
        ...result.notes,
        `Pesos de la fase ${phase.label} del proyecto (SIPGES), preliminares hasta su validación.`,
      ],
    };
  };

  return {
    indicators,
    irsa,
    config,

    async updateConfig(
      tenantId: string,
      patch: IrsaConfigPatch,
    ): Promise<Result<IrsaConfig, IrsaConfigError>> {
      const next = applyIrsaConfigPatch(await config(tenantId), patch);
      if (!next.ok) return err(next.error);
      await deps.configs.save(
        tenantId,
        next.value,
        deps.clock.now(),
        'Parámetros IRSA actualizados',
      );
      return ok(next.value);
    },

    async snapshot(tenantId: string, note: string): Promise<IrsaResult & { id: number }> {
      const result = await irsa(tenantId);
      const id = await deps.snapshots.insert(tenantId, {
        ts: deps.clock.now(),
        irsa: result.irsa,
        level: result.level,
        scores: result.scores,
        configVersion: result.config_version,
        note,
        auditDetail: `Corte IRSA guardado: ${pyFloat(result.irsa)} ${result.level}`,
      });
      return { id, ...result };
    },

    history: (tenantId: string, limit: number | null): Promise<IrsaSnapshot[]> =>
      deps.snapshots.list(tenantId, limit),

    modelStatus: () => MODEL_STATUS,
    validationTemplate,
  };
};

export type IndicatorsService = ReturnType<typeof createIndicatorsService>;
