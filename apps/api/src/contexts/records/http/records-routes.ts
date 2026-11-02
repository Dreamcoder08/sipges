import {
  ImportIn,
  type ImportReport,
  type RecordCreated,
  RecordIn,
  type RecordVersion,
  type RecordsSummary,
} from '@sipges/contracts';
import type { Context } from 'hono';
import { Hono } from 'hono';
import type { AppEnv } from '../../../platform/http/env.ts';
import { isoSeconds } from '../../../platform/http/time.ts';
import { type Parsed, parseIntQuery, parseJson } from '../../../platform/http/validation.ts';
import { formatScope } from '../../tenancy/application/index.ts';
import {
  type InvalidPayload,
  type RecordsService,
  type RecordsSummaryQuery,
  isImportable,
  moduleForSlug,
} from '../application/index.ts';

const UNKNOWN_MODULE = { detail: 'Módulo no válido' };
const MISSING_RECORD = { detail: 'Registro no encontrado' };

const tenantOf = (c: Context<AppEnv>) => formatScope(c.get('scope'));

/** The per-module id rule the use case refused, reported FastAPI-style (docs/adr/0007). */
const invalidPayload = (c: Context<AppEnv>, problem: InvalidPayload) =>
  c.json(
    {
      detail: [
        { type: 'value_error', loc: ['body', 'payload', problem.field], msg: problem.message },
      ],
    },
    422,
  );

/** `limit`, `offset` and `q` of a list, validated the same way for every list route. */
const pageQuery = (
  c: Context<AppEnv>,
): Parsed<{ limit: number; offset: number; q: string | null }> => {
  const limit = parseIntQuery(c, 'limit', 200);
  if (!limit.ok) return limit;
  const offset = parseIntQuery(c, 'offset', 0);
  if (!offset.ok) return offset;
  if (!Number.isSafeInteger(offset.value) || offset.value < 0)
    return {
      ok: false,
      response: c.json({ detail: 'offset debe ser un entero no negativo' }, 422),
    };
  return {
    ok: true,
    value: { limit: limit.value, offset: offset.value, q: c.req.query('q') ?? null },
  };
};

/** Generic CRUD for the territorial modules (app.py /api/{module}); always tenant-scoped. */
export const recordsRoutes = (records: RecordsService, recordsSummary: RecordsSummaryQuery) =>
  new Hono<AppEnv>()
    // Registered before /api/:module/:id: «registros» is the hub, never a record type.
    .get('/api/registros/summary', async (c) => {
      const page = pageQuery(c);
      if (!page.ok) return page.response;
      const summary = await recordsSummary(tenantOf(c), page.value);
      return c.json({
        counts: summary.counts,
        rows: summary.rows.map((row) => ({
          module: row.slug,
          id: row.id,
          title: row.title,
          territory: row.territory,
          date: row.date,
          verification: row.verification,
          validation: row.validation,
          updated_at: isoSeconds(row.updatedAt),
        })),
      } satisfies RecordsSummary);
    })

    .get('/api/:module', async (c) => {
      const module = moduleForSlug(c.req.param('module'));
      if (!module) return c.json(UNKNOWN_MODULE, 404);
      const page = pageQuery(c);
      if (!page.ok) return page.response;
      const rows = await records.list(tenantOf(c), module, page.value);
      return c.json(
        rows.map((row) => ({
          ...row.payload,
          _id: row.id,
          _updated_at: isoSeconds(row.updatedAt),
        })),
      );
    })

    .get('/api/:module/:id', async (c) => {
      const module = moduleForSlug(c.req.param('module'));
      if (!module) return c.json(UNKNOWN_MODULE, 404);
      const row = await records.get(tenantOf(c), module, c.req.param('id'));
      if (!row) return c.json(MISSING_RECORD, 404);
      return c.json({ ...row.payload, _id: row.id });
    })

    .get('/api/:module/:id/history', async (c) => {
      const module = moduleForSlug(c.req.param('module'));
      if (!module) return c.json(UNKNOWN_MODULE, 404);
      const versions = await records.history(tenantOf(c), module, c.req.param('id'));
      if (versions.length === 0) return c.json(MISSING_RECORD, 404);
      return c.json(
        versions.map((version): RecordVersion => ({
          version: version.version,
          operation: version.operation,
          actor: version.actor,
          at: isoSeconds(version.at),
          payload: version.payload,
          changes: version.changes,
        })),
      );
    })

    .post('/system/import/:module', async (c) => {
      const module = moduleForSlug(c.req.param('module'));
      if (!module || !isImportable(module)) return c.json(UNKNOWN_MODULE, 404);
      const body = await parseJson(c, ImportIn);
      if (!body.ok) return body.response;
      const report = await records.importRows(tenantOf(c), module, body.value.rows, {
        dryRun: body.value.dry_run,
        source: body.value.source,
      });
      return c.json(
        {
          applied: report.applied,
          created: report.created,
          updated: report.updated,
          problems: [...report.problems],
        } satisfies ImportReport,
        report.problems.length && !body.value.dry_run ? 422 : 200,
      );
    })

    .post('/api/:module', async (c) => {
      const module = moduleForSlug(c.req.param('module'));
      if (!module) return c.json(UNKNOWN_MODULE, 404);
      const body = await parseJson(c, RecordIn);
      if (!body.ok) return body.response;
      const created = await records.create(tenantOf(c), module, body.value.payload);
      if (!created.ok && created.error.kind === 'invalid') return invalidPayload(c, created.error);
      if (!created.ok) throw new Error('Could not allocate a record id');
      return c.json({ ok: true, id: created.value } satisfies RecordCreated);
    })

    .put('/api/:module/:id', async (c) => {
      const module = moduleForSlug(c.req.param('module'));
      if (!module) return c.json(UNKNOWN_MODULE, 404);
      const body = await parseJson(c, RecordIn);
      if (!body.ok) return body.response;
      const replaced = await records.replace(
        tenantOf(c),
        module,
        c.req.param('id'),
        body.value.payload,
      );
      if (replaced.ok) return c.json({ ok: true });
      return replaced.error.kind === 'invalid'
        ? invalidPayload(c, replaced.error)
        : c.json(MISSING_RECORD, 404);
    })

    .delete('/api/:module/:id', async (c) => {
      const module = moduleForSlug(c.req.param('module'));
      if (!module) return c.json(UNKNOWN_MODULE, 404);
      const removed = await records.remove(tenantOf(c), module, c.req.param('id'));
      return removed ? c.json({ ok: true }) : c.json(MISSING_RECORD, 404);
    });
