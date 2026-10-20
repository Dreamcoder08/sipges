import { z } from 'zod';

/** MASCLI 4.0 project settings (docs/adr/0020 §1). */
const meaning = z
  .string()
  .trim()
  .min(1)
  .max(120)
  .refine((value) => !value.includes('\0'));

export const LevelMeanings = z.object({
  Verde: meaning,
  Amarillo: meaning,
  Naranja: meaning,
  Rojo: meaning,
});
export type LevelMeanings = z.infer<typeof LevelMeanings>;

/** Situation score at which each colour starts; Verde is everything below Amarillo. */
export const SituationThresholds = z
  .object({
    Amarillo: z.number().positive().max(1000),
    Naranja: z.number().positive().max(1000),
    Rojo: z.number().positive().max(1000),
  })
  .refine((t) => t.Amarillo < t.Naranja && t.Naranja < t.Rojo, {
    message: 'Los umbrales deben ser crecientes: Amarillo < Naranja < Rojo',
  });
export type SituationThresholds = z.infer<typeof SituationThresholds>;

/** Condition ids of the recommendation catalogue (docs/adr/0020 §3). */
export const RecommendationId = z.enum([
  'verificar',
  'seguimiento',
  'contactar',
  'reunion',
  'monitoreo',
  'narrativas',
  'buzon',
  'inmediata',
]);
export type RecommendationId = z.infer<typeof RecommendationId>;

const recommendation = z
  .string()
  .trim()
  .min(1)
  .max(300)
  .refine((value) => !value.includes('\0'));

/** Project life-cycle phase (docs/adr/0021 §4). */
export const ProjectPhase = z.enum(['exploracion', 'construccion', 'operacion', 'cierre']);
export type ProjectPhase = z.infer<typeof ProjectPhase>;

const weight = z.number().min(0).max(1);
/** IRSA weights for the six dimensions; like the general ones they sum to 1 ± 0.02. */
export const PhaseWeights = z
  .object({ G: weight, A: weight, D: weight, N: weight, E: weight, I: weight })
  .refine((w) => Math.abs(Object.values(w).reduce((a, b) => a + b, 0) - 1) <= 0.02, {
    message: 'Los pesos de una fase deben sumar 1',
  });
export type PhaseWeights = z.infer<typeof PhaseWeights>;

export const ProjectSettingsIn = z.object({
  version4: z.boolean().optional(),
  level_meanings: LevelMeanings.optional(),
  window_days: z.number().int().min(7).max(365).optional(),
  half_life_days: z.number().int().min(1).max(180).optional(),
  thresholds: SituationThresholds.optional(),
  recommendations: z.partialRecord(RecommendationId, recommendation).optional(),
  /** null clears the phase. */
  phase: ProjectPhase.nullable().optional(),
  /** Per phase: weights to save, or null to go back to the general IRSA weights. */
  phase_weights: z.partialRecord(ProjectPhase, PhaseWeights.nullable()).optional(),
});
export type ProjectSettingsIn = z.infer<typeof ProjectSettingsIn>;

export const ProjectSettings = z.object({
  version4: z.boolean(),
  level_meanings: LevelMeanings,
  window_days: z.number(),
  half_life_days: z.number(),
  thresholds: z.object({ Amarillo: z.number(), Naranja: z.number(), Rojo: z.number() }),
  /** Every condition with its current wording (project text or default). */
  recommendations: z.array(
    z.object({
      id: RecommendationId,
      condition: z.string(),
      text: z.string(),
      custom: z.boolean(),
    }),
  ),
  phase: ProjectPhase.nullable(),
  /** Every phase with its label, saved weights (if any) and the preliminary suggestion. */
  phases: z.array(
    z.object({
      id: ProjectPhase,
      label: z.string(),
      weights: z.record(z.string(), z.number()).nullable(),
      suggestion: z.record(z.string(), z.number()),
    }),
  ),
  updated_by: z.string(),
  updated_at: z.string().nullable(),
});
export type ProjectSettings = z.infer<typeof ProjectSettings>;

export const SituationCitation = z.object({
  module: z.string(),
  id: z.string(),
  title: z.string(),
  date: z.string(),
});
export type SituationCitation = z.infer<typeof SituationCitation>;

export const Situation = z.object({
  key: z.string(),
  kind: z.enum(['tema', 'actor', 'territorio']),
  label: z.string(),
  level: z.enum(['Verde', 'Amarillo', 'Naranja', 'Rojo']),
  score: z.number(),
  trend: z.enum(['en aumento', 'estable', 'en descenso']),
  summary: z.string(),
  reasons: z.array(z.object({ text: z.string(), records: z.array(z.string()) })),
  recommendations: z.array(z.string()),
  records: z.array(SituationCitation),
  actors: z.array(z.string()),
  territories: z.array(z.string()),
  topics: z.array(z.string()),
  last_date: z.string(),
});
export type Situation = z.infer<typeof Situation>;

export const SituationsReport = z.object({
  generated_at: z.string(),
  today: z.string(),
  window_days: z.number(),
  considered: z.number(),
  undated: z.number(),
  situations: z.array(Situation),
  narratives: z.object({
    total: z.number(),
    recent: z.number(),
    topics: z.array(z.object({ name: z.string(), count: z.number(), recent: z.number() })),
    platforms: z.array(z.object({ name: z.string(), count: z.number() })),
    tone: z.object({ now: z.number(), then: z.number() }).nullable(),
  }),
  method: z.string(),
  limitations: z.array(z.string()),
});
export type SituationsReport = z.infer<typeof SituationsReport>;
