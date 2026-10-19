import { z } from 'zod';
export const AlertState = z.enum([
  'Pendiente de verificación',
  'Corroborado',
  'Descartado',
  'En seguimiento',
]);
export const ActionStatus = z.enum(['Pendiente', 'En ejecución', 'Completada', 'Cancelada']);
export const AnalysisMode = z.enum(['automatic', 'semantic', 'rules']);
export const ClassifierResponse = z.object({
  classifier_version: z.string(),
  dimension: z.enum(['G', 'A', 'D', 'N', 'E', 'I']),
  dimension_label: z.string(),
  confidence: z.number(),
  nivel_sugerido: z.string(),
  scores: z.record(z.string(), z.number()),
  margin: z.number(),
  evidence: z.record(z.string(), z.array(z.object({ signal: z.string(), weight: z.number() }))),
  review_required: z.boolean(),
  nota: z.string(),
});
export const TextAnalysisResponse = z.object({
  version: z.string(),
  project_id: z.string(),
  source_url: z.string(),
  analyzed_chars: z.number(),
  topics: z.array(
    z.object({ tema: z.string(), terminos_detectados: z.array(z.string()), cantidad: z.number() }),
  ),
  signals: z.array(z.object({ senal: z.string(), terminos_detectados: z.array(z.string()) })),
  orientation: z.object({ score: z.number(), level: z.string(), meaning: z.string() }),
  project_comparison: z.array(
    z.object({ tema: z.string(), registros_relacionados_por_palabras: z.number() }),
  ),
  suggested_actions: z.array(z.string()),
  evidence: z.object({ fragment: z.string(), sha256: z.string() }),
  method: z.string(),
  limitations: z.array(z.string()),
  semantic: z
    .object({
      active: z.boolean(),
      method: z.string(),
      model: z.string().optional(),
      matches: z.array(
        z.object({ theme: z.string(), similarity: z.number(), reference: z.string() }),
      ),
      note: z.string(),
    })
    .optional(),
  verification_status: z.string().optional(),
  source_retrieved: z.literal(false).optional(),
});
const SourceRecord = z.object({ module: z.literal('Narrativas'), id: z.string() });
export const TerritorialAlert = z.object({
  id: z.string(),
  project_id: z.string(),
  created_at: z.string(),
  source_url: z.string(),
  source_type: z.string(),
  territory: z.string().nullable().optional(),
  source_record: SourceRecord.nullable().optional(),
  excerpt: z.string(),
  sha256: z.string(),
  level: z.string(),
  score: z.number(),
  method: z.string(),
  semantic_active: z.boolean(),
  status: AlertState,
  analyst_note: z.string(),
  reviewer_note: z.string().nullable(),
  reviewed_at: z.string().nullable(),
  themes: z.array(z.object({ tema: z.string() })),
  signals: z.array(z.unknown()),
  suggestions: z.array(z.string()),
});
export const TerritorialAlerts = z.array(TerritorialAlert);
export const TerritorialSummary = z.object({
  version: z.string(),
  project_id: z.string(),
  total: z.number(),
  by_status: z.record(z.string(), z.number()),
  by_priority: z.record(z.string(), z.number()),
  themes: z.array(z.object({ name: z.string(), count: z.number() })),
  irsa_integration: z.string(),
  caution: z.string(),
});
export const AlertCreated = z.object({
  outcome: z.enum(['created', 'duplicate']).optional(),
  territory: z.string().nullable().optional(),
  source_record: SourceRecord.nullable().optional(),
  id: z.string(),
  status: AlertState,
  analysis: TextAnalysisResponse,
  irsa_modified: z.literal(false),
  notice: z.string(),
});
export const AlertReviewed = z.object({
  ok: z.literal(true),
  status: AlertState,
  irsa_modified: z.literal(false),
  notice: z.string(),
});
export const PreventiveAction = z.object({
  id: z.string(),
  project_id: z.string(),
  alert_id: z.string(),
  title: z.string(),
  responsible: z.string(),
  due_date: z.string(),
  description: z.string(),
  status: ActionStatus,
  progress: z.number(),
  created_at: z.string(),
  updated_at: z.string(),
  history: z.array(
    z.object({
      id: z.string(),
      action_id: z.string(),
      created_at: z.string(),
      status: ActionStatus,
      progress: z.number(),
      note: z.string(),
      evidence_url: z.string().nullable(),
      /** MASCLI 4.0 decision receipt: the evidence file behind the decision (ADR 0021). */
      receipt: z
        .object({
          attachment_id: z.string(),
          file_name: z.string(),
          sha256: z.string(),
          decided_by: z.string(),
        })
        .nullable()
        .optional(),
    }),
  ),
});
export const PreventiveActions = z.array(PreventiveAction);
export const ActionSaved = z.object({ action: PreventiveAction, irsa_modified: z.literal(false) });
export const PreventionSummary = z.object({
  project_id: z.string(),
  total: z.number(),
  active: z.number(),
  overdue: z.number(),
  completed: z.number(),
  completion_percent: z.number(),
  average_progress: z.number(),
  irsa_modified: z.literal(false),
  notice: z.string(),
});
const ManagementAction = z.object({
  id: z.string(),
  alert_id: z.string(),
  title: z.string(),
  responsible: z.string(),
  due_date: z.string(),
  status: z.string(),
  progress: z.number(),
  updated_at: z.string(),
});
export const ManagementOverview = z.object({
  version: z.string(),
  project_id: z.string(),
  generated_at: z.string(),
  metrics: z.object({
    digital_alerts: z.number(),
    high_priority_alerts: z.number(),
    pending_review: z.number(),
    total_actions: z.number(),
    active_actions: z.number(),
    overdue_actions: z.number(),
    completed_actions: z.number(),
    completion_percent: z.number(),
    average_progress: z.number(),
    registered_commitments: z.number(),
    overdue_commitments_explicit: z.number(),
  }),
  alerts_by_level: z.record(z.string(), z.number()),
  actions_by_status: z.record(z.string(), z.number()),
  actions_by_responsible: z.array(
    z.object({ name: z.string(), total: z.number(), overdue: z.number() }),
  ),
  critical_actions: z.array(ManagementAction),
  recent_alerts: z.array(
    z.object({
      id: z.string(),
      created_at: z.string(),
      source_url: z.string(),
      source_type: z.string(),
      level: z.string(),
      score: z.number(),
      status: z.string(),
      reviewed_at: z.string().nullable(),
    }),
  ),
  commitments: z.array(
    z.object({ id: z.string(), responsible: z.string(), status: z.string(), due_date: z.string() }),
  ),
  methodology: z.string(),
  limitations: z.array(z.string()),
});
