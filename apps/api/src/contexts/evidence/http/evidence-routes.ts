import type { Context } from 'hono';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { AppEnv } from '../../../platform/http/env.ts';
import { isoSeconds } from '../../../platform/http/time.ts';
import { parseIntQuery } from '../../../platform/http/validation.ts';
import { formatScope } from '../../tenancy/application/index.ts';
import type { Attachment, EvidenceService, UploadError } from '../application/index.ts';

/** Multipart overhead allowed on top of the file itself before the body is refused unread. */
const MULTIPART_SLACK = 64 * 1024;

const NOT_FOUND = { detail: 'Archivo no encontrado' };

const megabytes = (bytes: number) => Math.floor(bytes / (1024 * 1024));

const tooLarge = (c: Context, maxBytes: number) =>
  c.json({ detail: `El archivo supera el límite de ${megabytes(maxBytes)} MB` }, 413);

const UPLOAD_ERRORS = (maxBytes: number) =>
  ({
    module: [400, 'Módulo de vínculo no válido'],
    extension: [
      415,
      'Tipo de archivo no permitido. Use PDF, Office, CSV, TXT o imágenes JPG/PNG/WEBP.',
    ],
    content_mismatch: [415, 'El contenido del archivo no corresponde a su extensión'],
    empty: [400, 'El archivo está vacío'],
    too_large: [413, `El archivo supera el límite de ${megabytes(maxBytes)} MB`],
    record: [404, 'No existe el registro al que se desea vincular el archivo'],
  }) as const satisfies Record<UploadError['kind'], readonly [number, string]>;

/** app.py _attachment_dict, without the internal storage key. */
const toJson = (a: Attachment) => ({
  id: a.id,
  original_name: a.originalName,
  content_type: a.contentType,
  size_bytes: a.sizeBytes,
  sha256: a.sha256,
  linked_module: a.linkedModule,
  linked_record_id: a.linkedRecordId,
  document_type: a.documentType,
  author: a.author,
  verification: a.verification,
  notes: a.notes,
  project_id: a.projectId,
  project_name: a.projectName,
  Proyecto_ID: a.projectId,
  Proyecto: a.projectName,
  created_at: isoSeconds(a.createdAt),
  download_url: `/system/uploads/${encodeURIComponent(a.id)}/download`,
});

const missingField = (c: Context, field: string) =>
  c.json({ detail: [{ type: 'missing', loc: ['body', field], msg: 'Field required' }] }, 422);

const text = (value: unknown) => (typeof value === 'string' ? value : undefined);

/** Evidence files (app.py /system/uploads); every call is limited to the active tenant. */
export const evidenceRoutes = (evidence: EvidenceService) =>
  new Hono<AppEnv>()
    .post(
      '/system/uploads',
      bodyLimit({
        maxSize: evidence.maxUploadBytes + MULTIPART_SLACK,
        onError: (c) => tooLarge(c, evidence.maxUploadBytes),
      }),
      async (c) => {
        let form: Record<string, unknown>;
        try {
          form = await c.req.parseBody();
        } catch {
          return c.json(
            { detail: [{ type: 'value_error', loc: ['body'], msg: 'Invalid form body' }] },
            422,
          );
        }
        const file = form.file;
        if (!(file instanceof File)) return missingField(c, 'file');
        const linkedModule = text(form.linked_module);
        if (linkedModule === undefined) return missingField(c, 'linked_module');
        const linkedRecordId = text(form.linked_record_id);
        if (linkedRecordId === undefined) return missingField(c, 'linked_record_id');

        const scope = c.get('scope');
        const result = await evidence.upload({
          tenantId: formatScope(scope),
          scopeProjectId: scope.projectId,
          fileName: file.name,
          bytes: new Uint8Array(await file.arrayBuffer()),
          linkedModule,
          linkedRecordId,
          documentType: text(form.document_type),
          author: text(form.author),
          verification: text(form.verification),
          notes: text(form.notes),
        });
        if (!result.ok) {
          const [status, detail] = UPLOAD_ERRORS(evidence.maxUploadBytes)[result.error.kind];
          return c.json({ detail }, status);
        }
        return c.json({ ok: true, attachment: toJson(result.value) });
      },
    )

    .get('/system/uploads', async (c) => {
      const limit = parseIntQuery(c, 'limit', 200);
      if (!limit.ok) return limit.response;
      const rows = await evidence.list(formatScope(c.get('scope')), {
        linkedModule: c.req.query('linked_module') ?? null,
        linkedRecordId: c.req.query('linked_record_id') ?? null,
        q: c.req.query('q') ?? null,
        limit: limit.value,
      });
      return c.json(rows.map(toJson));
    })

    .get('/system/uploads/:id', async (c) => {
      const row = await evidence.get(formatScope(c.get('scope')), c.req.param('id'));
      return row ? c.json(toJson(row)) : c.json(NOT_FOUND, 404);
    })

    .get('/system/uploads/:id/download', async (c) => {
      const result = await evidence.download(formatScope(c.get('scope')), c.req.param('id'));
      if (result.kind === 'missing_metadata') return c.json(NOT_FOUND, 404);
      if (result.kind === 'missing_object') {
        return c.json({ detail: 'El archivo ya no está disponible en este almacenamiento' }, 410);
      }
      const { attachment, bytes } = result;
      return c.body(new Uint8Array(bytes), 200, {
        'Content-Type': attachment.contentType,
        'Content-Length': String(bytes.length),
        // originalName is sanitized to [A-Za-z0-9._-], so it is safe inside the quotes.
        'Content-Disposition': `attachment; filename="${attachment.originalName}"`,
      });
    });
