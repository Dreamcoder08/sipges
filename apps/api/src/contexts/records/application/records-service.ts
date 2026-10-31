import { type Result, err, ok } from '@mascli/kernel';
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

    async remove(tenantId: string, module: ModuleName, id: string): Promise<boolean> {
      return isLookupableId(id) && store.remove(tenantId, module, id, NOTES.delete, clock.now());
    },
  };
};

export type RecordsService = ReturnType<typeof createRecordsService>;
