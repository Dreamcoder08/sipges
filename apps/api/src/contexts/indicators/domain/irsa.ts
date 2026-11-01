import { type Result, err, ok } from '@sipges/kernel';
import {
  DIMENSIONS,
  type Dimension,
  type Indicator,
  type IndicatorsReport,
  VALIDATION_STATUS,
} from './indicators.ts';
import { pyRound } from './python.ts';
import type { IrsaConfig, Thresholds } from './types.ts';

/** IRSA v0.4 (app.py:1619 compute_irsa): weighted indicator-level dimension scores. */

export const CONFIG_VERSION = '0.4-indicators';
const FALLBACK_LEVEL = 'Rojo';
const MAX_DRIVERS = 15;
const WEIGHT_TOLERANCE = 0.02;

export type IrsaDriver = {
  readonly dimension: Dimension;
  readonly dimension_label: string;
  readonly type: 'indicador';
  readonly id: string;
  readonly label: string;
  readonly points: number;
  readonly confidence: string;
  readonly explanation: string;
};

export type IrsaResult = {
  readonly irsa: number;
  readonly level: string;
  readonly scores: Record<Dimension, number>;
  readonly weights: IrsaConfig['weights'];
  readonly thresholds: Thresholds;
  readonly drivers: IrsaDriver[];
  readonly details: Record<Dimension, Indicator[]>;
  readonly availability: Record<Dimension, number>;
  readonly indicators: Indicator[];
  readonly config_version: string;
  readonly status: string;
  readonly notes: string[];
};

/** First band whose inclusive range contains the value; gaps and overflow fall back to Rojo. */
export const selectBand = (irsa: number, thresholds: Thresholds): string =>
  Object.entries(thresholds).find(([, [lo, hi]]) => lo <= irsa && irsa <= hi)?.[0] ??
  FALLBACK_LEVEL;

export const computeIrsa = (config: IrsaConfig, report: IndicatorsReport): IrsaResult => {
  const scores = report.dimension_scores;
  const weights = config.weights;
  const irsa = pyRound(
    DIMENSIONS.reduce((sum, d) => sum + (scores[d] ?? 0) * (weights[d] ?? 0), 0),
    2,
  );
  const drivers = report.indicators
    .flatMap((x): IrsaDriver[] =>
      x.score === null
        ? []
        : [
            {
              dimension: x.dimension,
              dimension_label: x.dimension_label,
              type: 'indicador',
              id: x.code,
              label: x.name,
              points: pyRound(x.score, 2),
              confidence: x.confidence,
              explanation: x.explanation,
            },
          ],
    )
    // Array.prototype.sort is stable, like Python sorted().
    .sort((a, b) => b.points - a.points)
    .slice(0, MAX_DRIVERS);
  return {
    irsa,
    level: selectBand(irsa, config.thresholds),
    scores,
    weights,
    thresholds: config.thresholds,
    drivers,
    details: report.dimensions,
    availability: report.availability,
    indicators: report.indicators,
    config_version: CONFIG_VERSION,
    status: VALIDATION_STATUS,
    notes: [
      'El IRSA V0.4 se calcula desde indicadores desagregados G1–I6.',
      'Los indicadores no calculables por falta de datos se excluyen del promedio de su dimensión.',
      'Los métodos actuales son reglas/proxies transparentes para prototipado; requieren validación y calibración.',
    ],
  };
};

export type IrsaConfigPatch = {
  readonly weights?: Readonly<Record<string, number>> | undefined;
  readonly thresholds?: Thresholds | undefined;
  readonly contributions?: Readonly<Record<string, number>> | undefined;
};

export type IrsaConfigError = 'weights_sum';

/** app.py irsa_config_update: weights over every dimension must sum to 1 ± 0.02. */
export const applyIrsaConfigPatch = (
  config: IrsaConfig,
  patch: IrsaConfigPatch,
): Result<IrsaConfig, IrsaConfigError> => {
  let next: IrsaConfig = config;
  if (patch.weights) {
    const w = patch.weights;
    const weights = Object.fromEntries(DIMENSIONS.map((d) => [d, w[d] ?? 0]));
    const total = Object.values(weights).reduce((a, b) => a + b, 0);
    if (Math.abs(total - 1) > WEIGHT_TOLERANCE) return err('weights_sum');
    next = { ...next, weights };
  }
  if (patch.thresholds) next = { ...next, thresholds: patch.thresholds };
  if (patch.contributions) {
    next = { ...next, contributions: { ...next.contributions, ...patch.contributions } };
  }
  return ok(next);
};
