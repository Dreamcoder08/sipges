import { type Result, err, ok } from '@mascli/kernel';
import { type FieldChange, type VersionOperation, diffPayloads } from '../domain/history.ts';
import {
  type ModuleName,
  type Payload,
  collisionId,
  isLookupableId,
  recordIdFor,
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
    list: (tenantId: string, module: ModuleName, query: { limit: number; q: string | null }) =>
      store.list(tenantId, module, { limit: boundLimit(query.limit), q: query.q || null }),

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
    ): Promise<Result<string, 'exhausted'>> {
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
      return id ? ok(id) : err('exhausted');
    },

    async replace(
      tenantId: string,
      module: ModuleName,
      id: string,
      payload: Payload,
    ): Promise<boolean> {
      return (
        isLookupableId(id) &&
        store.replace(tenantId, module, id, payload, NOTES.update, clock.now())
      );
    },

    async remove(tenantId: string, module: ModuleName, id: string): Promise<boolean> {
      return isLookupableId(id) && store.remove(tenantId, module, id, NOTES.delete, clock.now());
    },
  };
};

export type RecordsService = ReturnType<typeof createRecordsService>;
