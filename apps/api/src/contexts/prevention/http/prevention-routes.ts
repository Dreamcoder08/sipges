import { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../../../platform/http/env.ts';
import { isoSeconds } from '../../../platform/http/time.ts';
import { parseJson } from '../../../platform/http/validation.ts';
import {
  type CreateError,
  type PreventionService,
  type PreventiveAction,
  type UpdateError,
  isCalendarDate,
} from '../application/index.ts';

const CREATE_ERRORS = {
  alert_missing: [404, 'Alerta no pertenece al proyecto indicado'],
  alert_unverified: [409, 'La alerta necesita verificación humana antes de crear un plan'],
} as const satisfies Record<CreateError['kind'], readonly [number, string]>;

const UPDATE_ERRORS = {
  status: [422, 'Estado no válido'],
  completed_progress: [422, 'Una acción completada debe indicar 100%'],
  pending_progress: [422, 'Seleccione En ejecución cuando haya avance'],
  evidence_url: [422, 'Evidencia: use enlace http(s)'],
  missing: [404, 'Acción no encontrada'],
  reactivate: [409, 'No puede reactivar una acción cancelada'],
  note_required: [422, 'Justifique el cierre o cancelación'],
} as const satisfies Record<UpdateError['kind'], readonly [number, string]>;

/** Field limits of app.py `PreventiveActionIn` / `ActionUpdateIn`. */
const CreateBody = z.object({
  project_id: z.string().min(1).max(120).optional(),
  alert_id: z.string().min(1).max(80),
  title: z.string().min(5).max(200),
  responsible: z.string().min(2).max(150),
  due_date: z.string().refine(isCalendarDate, 'Input should be a valid date'),
  description: z.string().max(2000).default(''),
});

const UpdateBody = z.object({
  status: z.string(),
  progress: z.number().int().min(0).max(100),
  note: z.string().max(2000).default(''),
  evidence_url: z.string().max(2000).default(''),
});

const actionJson = (a: PreventiveAction) => ({
  id: a.id,
  project_id: a.projectId,
  alert_id: a.alertId,
  title: a.title,
  responsible: a.responsible,
  due_date: a.dueDate,
  description: a.description,
  status: a.status,
  progress: a.progress,
  created_at: isoSeconds(a.createdAt),
  updated_at: isoSeconds(a.updatedAt),
  history: a.history.map((h) => ({
    id: h.id,
    action_id: h.actionId,
    created_at: isoSeconds(h.createdAt),
    status: h.status,
    progress: h.progress,
    note: h.note,
    evidence_url: h.evidenceUrl,
  })),
});

/** Preventive action plans (app.py:2161-2216); the scope's project is always used. */
export const preventionRoutes = (prevention: PreventionService) =>
  new Hono<AppEnv>()
    .post('/system/prevention/actions', async (c) => {
      const body = await parseJson(c, CreateBody);
      if (!body.ok) return body.response;
      const result = await prevention.create(c.get('scope'), {
        alertId: body.value.alert_id,
        title: body.value.title,
        responsible: body.value.responsible,
        dueDate: body.value.due_date,
        description: body.value.description,
      });
      if (!result.ok) {
        const [status, detail] = CREATE_ERRORS[result.error.kind];
        return c.json({ detail }, status);
      }
      return c.json({ action: actionJson(result.value), irsa_modified: false });
    })

    .get('/system/prevention/actions', async (c) =>
      c.json((await prevention.list(c.get('scope'))).map(actionJson)),
    )

    .patch('/system/prevention/actions/:id', async (c) => {
      const body = await parseJson(c, UpdateBody);
      if (!body.ok) return body.response;
      const result = await prevention.update(c.get('scope'), c.req.param('id'), {
        status: body.value.status,
        progress: body.value.progress,
        note: body.value.note,
        evidenceUrl: body.value.evidence_url,
      });
      if (!result.ok) {
        const [status, detail] = UPDATE_ERRORS[result.error.kind];
        return c.json({ detail }, status);
      }
      return c.json({ action: actionJson(result.value), irsa_modified: false });
    })

    .get('/system/prevention/summary', async (c) =>
      c.json(await prevention.summary(c.get('scope'))),
    );
