import { type Result, err, ok } from '@sipges/kernel';
import { type FieldChange, type VersionOperation, diffPayloads } from '../domain/history.ts';
import { type ImportProblem, MAX_IMPORT_ROWS, planImport } from '../domain/import.ts';
import {
  type ModuleName,
  type Payload,
  collisionId,
  isLookupableId,
  recordIdFor,
  validatePayload,
  withAssignedId,
} from '../domain/modules.ts';
import type { Clock, RandomHex, RecordStore, StoredRecord } from './ports.ts';

export type RecordVersion = {
  readonly version: number;
  readonly operation: VersionOperation;
  readonly actor: string;
  readonly at: Date;
  readonly payload: Payload | null;
  readonly changes: FieldChange[];
};

export type ImportReport = {
  readonly applied: boolean;
  readonly created: number;
  readonly updated: number;
  readonly problems: readonly ImportProblem[];
};

/** A payload the module's id rule refuses; nothing was written. */
export type InvalidPayload = {
  readonly kind: 'invalid';
  readonly field: string;
  readonly message: string;
};

const checkPayload = (module: ModuleName, payload: Payload): InvalidPayload | null => {
  const problem = validatePayload(module, payload);
  return problem ? { kind: 'invalid', ...problem } : null;
};

/** Absolute ceiling for list sizes (docs/adr/0008 #10). */
export const MAX_LIMIT = 500;

/** A negative SQLite LIMIT meant "no limit" in app.py; here every limit is capped. */
export const boundLimit = (limit: number) => (limit < 0 ? MAX_LIMIT : Math.min(limit, MAX_LIMIT));

const COLLISION_ATTEMPTS = 5;

const NOTES = {
  create: { action: 'CREATE', detail: 'Registro creado desde prototipo V0.2' },
  update: { action: 'UPDATE', detail: 'Registro actualizado' },
  delete: { action: 'DELETE', detail: 'Registro eliminado' },
} as const;

export const createRecordsService = (deps: {
  store: RecordStore;
  clock: Clock;
  randomHex: RandomHex;
}) => {
  const { store, clock, randomHex } = deps;
  return {
    list: (
      tenantId: string,
      module: ModuleName,
      query: { limit: number; q: string | null; offset?: number },
    ) =>
      store.list(tenantId, module, {
        limit: boundLimit(query.limit),
        q: query.q || null,
        offset: query.offset ?? 0,
      }),

    async get(tenantId: string, module: ModuleName, id: string): Promise<StoredRecord | null> {
      return isLookupableId(id) ? store.get(tenantId, module, id) : null;
    },

    /** Newest first, numbered from 1, each with its field changes against the previous one. */
    async history(tenantId: string, module: ModuleName, id: string): Promise<RecordVersion[]> {
      if (!isLookupableId(id)) return [];
      const versions = await store.history(tenantId, module, id);
      return versions
        .map((version, index) => ({
          version: index + 1,
          operation: version.operation,
          actor: version.actor,
          at: version.at,
          payload: version.payload,
          changes: diffPayloads(versions[index - 1]?.payload ?? null, version.payload),
        }))
        .reverse();
    },

    async create(
      tenantId: string,
      module: ModuleName,
      payload: Payload,
    ): Promise<Result<string, InvalidPayload | { readonly kind: 'exhausted' }>> {
      const invalid = checkPayload(module, payload);
      if (invalid) return err(invalid);
      const preferred = recordIdFor(module, payload, randomHex);
      function* candidates() {
        yield preferred;
        for (let i = 0; i < COLLISION_ATTEMPTS; i++) yield collisionId(preferred, randomHex);
      }
      const id = await store.create(
        tenantId,
        module,
        candidates(),
        (chosen) => withAssignedId(module, payload, chosen),
        NOTES.create,
        clock.now(),
      );
      return id ? ok(id) : err({ kind: 'exhausted' });
    },

    async replace(
      tenantId: string,
      module: ModuleName,
      id: string,
      payload: Payload,
    ): Promise<Result<true, InvalidPayload | { readonly kind: 'missing' }>> {
      const invalid = checkPayload(module, payload);
      if (invalid) return err(invalid);
      const replaced =
        isLookupableId(id) &&
        (await store.replace(tenantId, module, id, payload, NOTES.update, clock.now()));
      return replaced ? ok(true) : err({ kind: 'missing' });
    },

    /**
     * Spreadsheet import, all or nothing: a dry run reports what would be created, updated or
     * rejected; a real run refuses any batch with problems and merges the rest in one
     * transaction with a single IMPORT audit entry naming the source.
     */
    async importRows(
      tenantId: string,
      module: ModuleName,
      rows: readonly Readonly<Record<string, string>>[],
      options: { dryRun: boolean; source: string },
    ): Promise<ImportReport> {
      if (rows.length > MAX_IMPORT_ROWS) {
        return {
          applied: false,
          created: 0,
          updated: 0,
          problems: [{ row: 0, message: `Máximo ${MAX_IMPORT_ROWS} filas por importación` }],
        };
      }
      const plan = planImport(module, rows, randomHex);
      if (options.dryRun || plan.problems.length > 0 || plan.items.length === 0) {
        const existing = plan.items.length
          ? await store.existing(
              tenantId,
              module,
              plan.items.map((item) => item.id),
            )
          : new Set<string>();
        const updated = plan.items.filter((item) => existing.has(item.id)).length;
        return {
          applied: false,
          created: plan.items.length - updated,
          updated,
          problems: plan.problems,
        };
      }
      const source = options.source.trim().slice(0, 120) || 'archivo sin nombre';
      const result = await store.importBatch(
        tenantId,
        module,
        plan.items,
        {
          action: 'IMPORT',
          detail: `Importación de ${plan.items.length} filas desde ${source}`,
        },
        clock.now(),
      );
      return { applied: true, ...result, problems: [] };
    },

    /** Ids among `ids` already stored in `module` (unusable ids are never found). */
    existing: (tenantId: string, module: ModuleName, ids: readonly string[]) =>
      store.existing(tenantId, module, ids.filter(isLookupableId)),

    /**
     * Insert-only creation under caller-chosen, deterministic ids (document review approvals,
     * docs/operations/review-materialize.md). Values are normalized and validated exactly as a
     * spreadsheet import; any problem refuses the whole batch. Ids already stored are left
     * untouched, so re-running never duplicates nor overwrites an edited record. A dry run
     * writes nothing. One item is audited as CREATE under its id; a batch as one IMPORT entry.
     */
    async createMissing(
      tenantId: string,
      module: ModuleName,
      items: readonly { id: string; fields: Readonly<Record<string, string>> }[],
      options: { dryRun: boolean; source: string },
    ): Promise<{ created: number; existing: number; problems: readonly ImportProblem[] }> {
      if (items.length > MAX_IMPORT_ROWS)
        return {
          created: 0,
          existing: 0,
          problems: [{ row: 0, message: `Máximo ${MAX_IMPORT_ROWS} filas por importación` }],
        };
      // The caller's ids replace planImport's; a per-row counter keeps its throwaway ids for
      // modules without an id field distinct, so they can never refuse the batch as repeated.
      let row = 0;
      const plan = planImport(
        module,
        items.map((item) => item.fields),
        (length) => (row++).toString(16).padStart(length, '0'),
      );
      const problems = [...plan.problems];
      const seen = new Set<string>();
      items.forEach((item, index) => {
        if (!isLookupableId(item.id) || !item.id)
          problems.push({ row: index + 1, message: 'Código de registro inválido' });
        else if (seen.has(item.id))
          problems.push({ row: index + 1, message: `El código ${item.id} está repetido` });
        seen.add(item.id);
      });
      if (problems.length > 0) {
        problems.sort((a, b) => a.row - b.row);
        return { created: 0, existing: 0, problems };
      }
      // planImport numbers rows from 1 and keeps their order; the caller's id replaces its id.
      const planned = plan.items.map((entry) => ({
        id: items[entry.row - 1]?.id ?? entry.id,
        payload: entry.payload,
      }));
      const present = planned.length
        ? await store.existing(
            tenantId,
            module,
            planned.map((entry) => entry.id),
          )
        : new Set<string>();
      const fresh = planned.filter((entry) => !present.has(entry.id));
      if (options.dryRun || fresh.length === 0)
        return { created: fresh.length, existing: planned.length - fresh.length, problems: [] };
      const source = options.source.trim().slice(0, 120) || 'origen sin nombre';
      let created: number;
      const [single] = fresh;
      if (fresh.length === 1 && single) {
        const id = await store.create(
          tenantId,
          module,
          [single.id],
          () => single.payload,
          { action: 'CREATE', detail: `Registro creado desde ${source}` },
          clock.now(),
        );
        created = id ? 1 : 0;
      } else {
        created = (
          await store.importBatch(
            tenantId,
            module,
            fresh,
            { action: 'IMPORT', detail: `${fresh.length} registros creados desde ${source}` },
            clock.now(),
            { insertOnly: true },
          )
        ).created;
      }
      return { created, existing: planned.length - created, problems: [] };
    },

    async remove(tenantId: string, module: ModuleName, id: string): Promise<boolean> {
      return isLookupableId(id) && store.remove(tenantId, module, id, NOTES.delete, clock.now());
    },
  };
};

export type RecordsService = ReturnType<typeof createRecordsService>;
