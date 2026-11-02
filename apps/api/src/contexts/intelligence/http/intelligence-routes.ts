import { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../../../platform/http/env.ts';
import { isoSeconds } from '../../../platform/http/time.ts';
import { parseIntQuery, parseJson } from '../../../platform/http/validation.ts';
import type {
  AlertCreateError,
  AlertDecisionError,
  IntelligenceService,
  TerritorialAlert,
} from '../application/index.ts';

const ERRORS = {
  empty: [422, 'Ingrese el texto transcrito de la publicación.'],
  too_long: [413, 'Máximo 20 000 caracteres.'],
  mode: [422, 'Modo inválido'],
  url: [422, 'URL pública inválida'],
  unavailable: [
    503,
    'Modelo local no disponible. Instale Ollama, descargue el modelo configurado o seleccione análisis por reglas.',
  ],
  source_type: [422, 'Tipo de fuente inválido'],
} as const satisfies Record<AlertCreateError['kind'], readonly [number, string]>;

const DECISION_ERRORS = {
  status: [422, 'Estado inválido'],
  note_too_long: [422, 'Nota demasiado extensa'],
  missing: [404, 'Evaluación no encontrada'],
  same_person: [409, 'Otra persona debe confirmar la validación de una alerta de prioridad Alta'],
} as const satisfies Record<AlertDecisionError['kind'], readonly [number, string]>;

// `project_id` is accepted for compatibility; the tenancy middleware already refused any value
// other than the active scope's project, which is what the use cases receive.
const TextBody = z.object({
  text: z.string(),
  project_id: z.string().optional(),
  source_url: z.string().default(''),
});
const SemanticBody = TextBody.extend({ mode: z.string().default('automatic') });
const AlertBody = SemanticBody.extend({
  source_type: z.string().default('Publicación digital'),
  analyst_note: z.string().default(''),
  territory: z.string().max(500).nullable().optional(),
});
const DecisionBody = z.object({ status: z.string(), reviewer_note: z.string().default('') });
const RecordBody = z.object({ payload: z.record(z.string(), z.unknown()) });

const alertJson = (a: TerritorialAlert) => ({
  id: a.id,
  project_id: a.projectId,
  created_at: isoSeconds(a.createdAt),
  source_url: a.sourceUrl,
  source_type: a.sourceType,
  territory: a.territory ?? null,
  source_record: a.sourceRecord ?? null,
  excerpt: a.excerpt,
  sha256: a.sha256,
  level: a.level,
  score: a.score,
  method: a.method,
  semantic_active: a.semanticActive,
  status: a.status,
  analyst_note: a.analystNote,
  reviewer_note: a.reviewerNote,
  reviewed_at: a.reviewedAt ? isoSeconds(a.reviewedAt) : null,
  first_validator: a.firstValidator ?? null,
  themes: a.themes,
  signals: a.signals,
  suggestions: a.suggestions,
});

/** Classifier, text analysis and the territorial alert inbox (app.py:1251, 1939-2125). */
export const intelligenceRoutes = (
  intelligence: IntelligenceService,
  embedder: { configured: boolean; semanticSearch: boolean },
) =>
  new Hono<AppEnv>()
    // Whether semantic features can run; the web falls back to keyword search when not.
    .get('/system/intelligence/embedder', async (c) => {
      const status = await intelligence.embedderStatus(c.get('scope'));
      return c.json({
        configured: embedder.configured,
        available: status.available,
        reason: status.reason,
        model: status.model,
        egress: status.egress,
        semantic_search: embedder.semanticSearch,
      });
    })

    .post('/system/analyze', async (c) => {
      const body = await parseJson(c, RecordBody);
      if (!body.ok) return body.response;
      return c.json(intelligence.classify(body.value.payload));
    })

    .post('/system/intelligence/analyze-text', async (c) => {
      const body = await parseJson(c, TextBody);
      if (!body.ok) return body.response;
      const result = await intelligence.analyzeText(c.get('scope'), {
        text: body.value.text,
        sourceUrl: body.value.source_url,
      });
      if (!result.ok) {
        const [status, detail] = ERRORS[result.error.kind];
        return c.json({ detail }, status);
      }
      return c.json(result.value);
    })

    .post('/system/intelligence/semantic-analyze', async (c) => {
      const body = await parseJson(c, SemanticBody);
      if (!body.ok) return body.response;
      const result = await intelligence.semanticAnalyze(c.get('scope'), {
        text: body.value.text,
        sourceUrl: body.value.source_url,
        mode: body.value.mode,
      });
      if (!result.ok) {
        const [status, detail] = ERRORS[result.error.kind];
        return c.json({ detail }, status);
      }
      return c.json(result.value);
    })

    .post('/system/intelligence/territorial-alerts', async (c) => {
      const body = await parseJson(c, AlertBody);
      if (!body.ok) return body.response;
      const result = await intelligence.createAlert(c.get('scope'), {
        text: body.value.text,
        sourceUrl: body.value.source_url,
        mode: body.value.mode,
        sourceType: body.value.source_type,
        analystNote: body.value.analyst_note,
        territory: body.value.territory ?? null,
      });
      if (!result.ok) {
        const [status, detail] = ERRORS[result.error.kind];
        return c.json({ detail }, status);
      }
      return c.json({
        id: result.value.alert.id,
        status: result.value.alert.status,
        outcome: result.value.outcome,
        territory: result.value.alert.territory ?? null,
        source_record: result.value.alert.sourceRecord ?? null,
        analysis: result.value.analysis,
        irsa_modified: false,
        notice: 'La puntuación es prioridad de revisión, no riesgo social cuantificado.',
      });
    })

    .get('/system/intelligence/territorial-alerts', async (c) => {
      const limit = parseIntQuery(c, 'limit', 50);
      if (!limit.ok) return limit.response;
      const items = await intelligence.listAlerts(c.get('scope'), limit.value);
      return c.json(items.map(alertJson));
    })

    .get('/system/intelligence/territorial-alerts/:id', async (c) => {
      const alert = await intelligence.getAlert(c.get('scope'), c.req.param('id'));
      return alert ? c.json(alertJson(alert)) : c.json({ detail: 'Evaluación no encontrada' }, 404);
    })

    .patch('/system/intelligence/territorial-alerts/:id', async (c) => {
      const body = await parseJson(c, DecisionBody);
      if (!body.ok) return body.response;
      const result = await intelligence.decideAlert(
        c.get('scope'),
        { id: c.req.param('id'), status: body.value.status, note: body.value.reviewer_note },
        c.get('identity').username,
      );
      if (!result.ok) {
        const [status, detail] = DECISION_ERRORS[result.error.kind];
        return c.json({ detail }, status);
      }
      return c.json({
        ok: true,
        status: result.value.status,
        second_validation_required: result.value.pendingSecond,
        irsa_modified: false,
        notice:
          'La validación NO cambia el IRSA. Registrar cambios de indicadores requiere metodología aprobada.',
      });
    })

    .get('/system/intelligence/territorial-summary', async (c) =>
      c.json(await intelligence.summary(c.get('scope'))),
    );
