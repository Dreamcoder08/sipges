import { z } from 'zod';
import { Dimension, IrsaConfig, IrsaSnapshotRow, IrsaSummary } from './indicators.ts';

export const IndicatorReportItem = z.object({
  code: z.string(),
  score: z.number().nullable(),
  confidence: z.string(),
  method: z.string(),
  evidence_count: z.number(),
  explanation: z.string(),
  availability: z.string(),
  name: z.string(),
  definition: z.string(),
  dimension: Dimension,
  dimension_label: z.string(),
});
export type IndicatorReportItem = z.infer<typeof IndicatorReportItem>;
export const IndicatorsReport = z.object({
  dimensions: z.record(Dimension, z.array(IndicatorReportItem)),
  dimension_scores: z.record(Dimension, z.number()),
  availability: z.record(Dimension, z.number()),
  indicators: z.array(IndicatorReportItem),
  method_note: z.string(),
  validation_status: z.string(),
});
export const IrsaReport = IrsaSummary.extend({
  weights: IrsaConfig.shape.weights,
  thresholds: IrsaConfig.shape.thresholds,
  details: z.record(Dimension, z.array(IndicatorReportItem)),
  availability: z.record(Dimension, z.number()),
  indicators: z.array(IndicatorReportItem),
  status: z.string(),
  notes: z.array(z.string()),
});
export const IrsaHistory = z.array(IrsaSnapshotRow);
export const IrsaSnapshotResponse = IrsaReport.extend({
  ok: z.literal(true),
  id: z.number().int(),
});
export const IrsaConfigResponse = z.object({ ok: z.literal(true), config: IrsaConfig });
export const ValidationTemplate = z.object({
  status: z.literal('PENDIENTE'),
  rows: z.array(
    z.object({
      dimension: Dimension,
      code: z.string(),
      name: z.string(),
      definition: z.string(),
      expert_1: z.string().nullable(),
      expert_2: z.string().nullable(),
      expert_3: z.string().nullable(),
      expert_4: z.string().nullable(),
      expert_5: z.string().nullable(),
      aiken_v: z.string().nullable(),
      decision: z.string(),
    }),
  ),
});
export type ValidationTemplate = z.infer<typeof ValidationTemplate>;
