import type { Context } from 'hono';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { z } from 'zod';
import type { AppEnv } from '../../../platform/http/env.ts';
import { isoSeconds } from '../../../platform/http/time.ts';
import { parseJson } from '../../../platform/http/validation.ts';
import { formatScope } from '../../tenancy/application/index.ts';
import {
  type DocumentLabService,
  type ImportError,
  DEFAULT_REVIEW_PAGE,
  LAB_REPORT_FILENAME,
  MAX_REVIEW_PAGE,
  type ReadError,
  type ReviewItem,
} from '../application/index.ts';

/** Multipart overhead allowed on top of the files before the body is refused unread. */
const MULTIPART_SLACK = 64 * 1024;

const ANALYZE_ERRORS = {
  extension: [415, 'Tipo de documento no compatible'],
  too_large: [413, 'Archivo demasiado grande'],
  empty: [400, 'Archivo vacío'],
  too_many_pages: [413, 'El PDF supera 100 páginas'],
  unreadable: [422, 'No se puede leer el documento'],
  no_text: [422, 'No se detectó texto extraíble. Los PDF escaneados requieren OCR externo.'],
} as const satisfies Record<ReadError['kind'], readonly [number, string]>;

const COMPARE_ERRORS = {
  extension: [415, 'Formato no permitido'],
  too_large: [413, 'Tamaño inválido'],
  empty: [413, 'Tamaño inválido'],
  too_many_pages: [413, 'El PDF supera 100 páginas'],
  unreadable: [422, 'No se puede leer el documento'],
  no_text: [422, 'Documento sin texto extraíble'],
} as const satisfies Record<ReadError['kind'], readonly [number, string]>;

const IMPORT_ERRORS = {
  sha256: [422, 'SHA256 inválido'],
  too_many: [413, 'Máximo 75 hallazgos'],
  invalid_text: [422, 'Texto con caracteres no permitidos'],
} as const satisfies Record<ImportError['kind'], readonly [number, string]>;

const DECISION_ERRORS = {
  status: [422, 'Estado no permitido'],
  note_required: [422, 'La corroboración requiere nota sobre evidencia contrastada'],
  missing: [404, 'Hallazgo no encontrado'],
  invalid_text: [422, 'Texto con caracteres no permitidos'],
} as const;

const missingField = (c: Context, field: string) =>
  c.json({ detail: [{ type: 'missing', loc: ['body', field], msg: 'Field required' }] }, 422);

type FormFile = { fileName: string; bytes: Uint8Array };

type FormResult<F extends string> =
  { ok: true; files: Record<F, FormFile>; projectId: string } | { ok: false; response: Response };

/**
 * Reads the multipart form: every named file field is required, and a supplied `project_id`
 * must be the active scope's project (docs/adr/0008 #6: multipart forms are checked too).
 */
const readForm = async <F extends string>(
  c: Context<AppEnv>,
  fields: readonly F[],
): Promise<FormResult<F>> => {
  let form: Record<string, unknown>;
  try {
    form = await c.req.parseBody();
  } catch {
    return {
      ok: false,
      response: c.json(
        { detail: [{ type: 'value_error', loc: ['body'], msg: 'Invalid form body' }] },
        422,
      ),
    };
  }
  const scope = c.get('scope');
  const supplied = form.project_id;
  if (typeof supplied === 'string' && supplied && supplied !== scope.projectId) {
    return { ok: false, response: c.json({ detail: 'Proyecto fuera de alcance' }, 403) };
  }
  const files: Partial<Record<F, FormFile>> = {};
  for (const field of fields) {
    const file = form[field];
    if (!(file instanceof File)) return { ok: false, response: missingField(c, field) };
    files[field] = { fileName: file.name, bytes: new Uint8Array(await file.arrayBuffer()) };
  }
  return { ok: true, files: files as Record<F, FormFile>, projectId: scope.projectId };
};

const reviewJson = (item: ReviewItem) => ({
  id: item.id,
  project_id: item.projectId,
  source_file: item.sourceFile,
  source_sha256: item.sourceSha256,
  location: item.location,
  theme: item.theme,
  excerpt: item.excerpt,
  action: item.action,
  status: item.status,
  reviewer: item.reviewer,
  note: item.note,
  created_at: isoSeconds(item.createdAt),
  updated_at: isoSeconds(item.updatedAt),
});

/** Whole-number query value inside [min, max]; undefined means "not supplied". */
const boundedInt = (raw: string | undefined, min: number, max: number) => {
  if (raw === undefined) return undefined;
  if (!/^\d+$/.test(raw)) return null;
  const value = Number.parseInt(raw, 10);
  return value >= min && value <= max ? value : null;
};

const ReviewBatchBody = z.object({
  project_id: z.string().optional(),
  filename: z.string(),
  sha256: z.string(),
  items: z.array(z.record(z.string(), z.unknown())),
});

const ReviewDecisionBody = z.object({
  status: z.string(),
  reviewer: z.string().default(''),
  note: z.string().default(''),
});

/** Document lab (app.py:1762-1910): lexical reading, comparison and the review inbox. */
export const documentLabRoutes = (lab: DocumentLabService) => {
  const oneFile = bodyLimit({
    maxSize: lab.maxUploadBytes + MULTIPART_SLACK,
    onError: (c) => c.json({ detail: ANALYZE_ERRORS.too_large[1] }, 413),
  });
  const twoFiles = bodyLimit({
    maxSize: 2 * lab.maxUploadBytes + MULTIPART_SLACK,
    onError: (c) => c.json({ detail: COMPARE_ERRORS.too_large[1] }, 413),
  });

  return new Hono<AppEnv>()
    .post('/system/document-lab/analyze', oneFile, async (c) => {
      const form = await readForm(c, ['file']);
      if (!form.ok) return form.response;
      const result = await lab.analyze(form.files.file, form.projectId);
      if (!result.ok) {
        const [status, detail] = ANALYZE_ERRORS[result.error.kind];
        return c.json({ detail }, status);
      }
      return c.json(result.value);
    })

    .post('/system/document-lab/report.docx', oneFile, async (c) => {
      const form = await readForm(c, ['file']);
      if (!form.ok) return form.response;
      const result = await lab.report(form.files.file, form.projectId);
      if (!result.ok) {
        const [status, detail] = ANALYZE_ERRORS[result.error.kind];
        return c.json({ detail }, status);
      }
      return c.body(new Uint8Array(result.value), 200, {
        'Content-Type': lab.reportContentType,
        'Content-Disposition': `attachment; filename="${LAB_REPORT_FILENAME}"`,
      });
    })

    .post('/system/document-lab/compare', twoFiles, async (c) => {
      const form = await readForm(c, ['file_a', 'file_b']);
      if (!form.ok) return form.response;
      const result = await lab.compare(form.files.file_a, form.files.file_b, form.projectId);
      if (!result.ok) {
        const [status, detail] = COMPARE_ERRORS[result.error.kind];
        return c.json({ detail }, status);
      }
      return c.json(result.value);
    })

    .post('/system/document-lab/review/import', async (c) => {
      const body = await parseJson(c, ReviewBatchBody);
      if (!body.ok) return body.response;
      const scope = c.get('scope');
      const result = await lab.importReview(formatScope(scope), {
        projectId: body.value.project_id || scope.projectId,
        filename: body.value.filename,
        sha256: body.value.sha256,
        items: body.value.items,
      });
      if (!result.ok) {
        const [status, detail] = IMPORT_ERRORS[result.error.kind];
        return c.json({ detail }, status);
      }
      return c.json({
        ok: true,
        new_items: result.value,
        message: 'Sólo se guardaron extractos de revisión, no los archivos originales.',
      });
    })

    .get('/system/document-lab/review', async (c) => {
      const scope = c.get('scope');
      const limit = boundedInt(c.req.query('limit'), 1, MAX_REVIEW_PAGE);
      if (limit === null) {
        return c.json(
          { detail: `Parámetro limit inválido: use un entero de 1 a ${MAX_REVIEW_PAGE}` },
          422,
        );
      }
      const offset = boundedInt(c.req.query('offset'), 0, Number.MAX_SAFE_INTEGER);
      if (offset === null) {
        return c.json(
          { detail: 'Parámetro offset inválido: use un entero mayor o igual a 0' },
          422,
        );
      }
      const page = await lab.listReview(formatScope(scope), {
        projectId: c.req.query('project_id') || scope.projectId,
        status: c.req.query('status') ?? null,
        theme: c.req.query('theme') ?? null,
        limit: limit ?? DEFAULT_REVIEW_PAGE,
        offset: offset ?? 0,
      });
      return c.json({
        items: page.items.map(reviewJson),
        total: page.total,
        limit: limit ?? DEFAULT_REVIEW_PAGE,
        offset: offset ?? 0,
        themes: page.themes,
        limitations: 'Revisado no implica verdad certificada: comprobar fuente y documentación.',
      });
    })

    .patch('/system/document-lab/review/:id', async (c) => {
      const body = await parseJson(c, ReviewDecisionBody);
      if (!body.ok) return body.response;
      const result = await lab.decide(formatScope(c.get('scope')), {
        id: c.req.param('id'),
        ...body.value,
      });
      if (!result.ok) {
        const [status, detail] = DECISION_ERRORS[result.error.kind];
        return c.json({ detail }, status);
      }
      return c.json({ ok: true, ...result.value });
    });
};
