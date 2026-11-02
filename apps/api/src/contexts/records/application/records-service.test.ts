import { describe, expect, it } from 'vitest';
import type { RecordStore } from './ports.ts';
import { createRecordsService } from './records-service.ts';

/** A store that only counts writes: an invalid payload must never reach it. */
const countingStore = () => {
  const writes: string[] = [];
  const store = {
    create: async () => {
      writes.push('create');
      return 'EV-1';
    },
    replace: async () => {
      writes.push('replace');
      return true;
    },
  } as unknown as RecordStore;
  return { store, writes };
};

const serviceWith = (store: RecordStore) =>
  createRecordsService({ store, clock: { now: () => new Date(0) }, randomHex: () => 'ab' });

const INVALID = {
  kind: 'invalid',
  field: 'ID_Evento',
  message: 'ID_Evento must be a string or number of at most 200 characters',
};

describe('records use cases enforce the per-module id rule', () => {
  it('create rejects a non-scalar id without writing', async () => {
    const { store, writes } = countingStore();
    const created = await serviceWith(store).create('t1', 'Eventos', {
      ID_Evento: { nested: true },
    });
    expect(created).toEqual({ ok: false, error: INVALID });
    expect(writes).toEqual([]);
  });

  it('replace rejects an over-long id without writing', async () => {
    const { store, writes } = countingStore();
    const replaced = await serviceWith(store).replace('t1', 'Eventos', 'EV-1', {
      ID_Evento: 'x'.repeat(201),
    });
    expect(replaced).toEqual({ ok: false, error: INVALID });
    expect(writes).toEqual([]);
  });

  it('still creates and replaces valid payloads', async () => {
    const { store, writes } = countingStore();
    const service = serviceWith(store);
    expect(await service.create('t1', 'Eventos', { ID_Evento: 'EV-1' })).toEqual({
      ok: true,
      value: 'EV-1',
    });
    expect(await service.replace('t1', 'Eventos', 'EV-1', { ID_Evento: 'EV-1' })).toEqual({
      ok: true,
      value: true,
    });
    expect(writes).toEqual(['create', 'replace']);
  });
});

describe('createMissing (insert-only under caller-chosen ids)', () => {
  const memoryStore = (present: string[]) => {
    const writes: { kind: string; ids: string[]; payloads: unknown[] }[] = [];
    const store = {
      existing: async (_t: string, _m: string, ids: readonly string[]) =>
        new Set(ids.filter((id) => present.includes(id))),
      create: async (
        _t: string,
        _m: string,
        candidates: Iterable<string>,
        payloadFor: (id: string) => unknown,
      ) => {
        const [id = ''] = [...candidates];
        writes.push({ kind: 'create', ids: [id], payloads: [payloadFor(id)] });
        return id;
      },
      importBatch: async (
        _t: string,
        _m: string,
        items: readonly { id: string; payload: unknown }[],
        _note: unknown,
        _at: Date,
        options?: { insertOnly: boolean },
      ) => {
        writes.push({
          kind: options?.insertOnly ? 'insertOnly' : 'merge',
          ids: items.map((item) => item.id),
          payloads: items.map((item) => item.payload),
        });
        return { created: items.length, updated: 0 };
      },
    } as unknown as RecordStore;
    return { store, writes };
  };

  it('normalizes like an import, skips present ids and never merges', async () => {
    const { store, writes } = memoryStore(['REV-2']);
    const report = await serviceWith(store).createMissing(
      't1',
      'Demandas',
      [
        { id: 'REV-1', fields: { ID_Demanda: 'REV-1', Descripcion: '  Texto  ', Tema: ' ' } },
        { id: 'REV-2', fields: { ID_Demanda: 'REV-2', Descripcion: 'Otro' } },
        { id: 'REV-3', fields: { ID_Demanda: 'REV-3', Descripcion: 'Tercero' } },
      ],
      { dryRun: false, source: 'bandeja' },
    );
    expect(report).toEqual({ created: 2, existing: 1, problems: [] });
    expect(writes).toEqual([
      {
        kind: 'insertOnly',
        ids: ['REV-1', 'REV-3'],
        payloads: [
          { ID_Demanda: 'REV-1', Descripcion: 'Texto' },
          { ID_Demanda: 'REV-3', Descripcion: 'Tercero' },
        ],
      },
    ]);
  });

  it('creates a single item under its own audited id and writes nothing on a dry run', async () => {
    const { store, writes } = memoryStore([]);
    const service = serviceWith(store);
    const item = { id: 'REV-9', fields: { Asunto: 'Hecho' } };
    expect(
      await service.createMissing('t1', 'Hechos_Compartidos', [item], {
        dryRun: true,
        source: 'x',
      }),
    ).toEqual({ created: 1, existing: 0, problems: [] });
    expect(writes).toEqual([]);
    await service.createMissing('t1', 'Hechos_Compartidos', [item], {
      dryRun: false,
      source: 'x',
    });
    expect(writes).toEqual([{ kind: 'create', ids: ['REV-9'], payloads: [{ Asunto: 'Hecho' }] }]);
  });

  it('never refuses rows of a module without an id field as repeated', async () => {
    const { store, writes } = memoryStore([]);
    const report = await serviceWith(store).createMissing(
      't1',
      'Hechos_Compartidos',
      [
        { id: 'REV-1', fields: { Asunto: 'Uno' } },
        { id: 'REV-2', fields: { Asunto: 'Dos' } },
      ],
      { dryRun: false, source: 'x' },
    );
    expect(report).toEqual({ created: 2, existing: 0, problems: [] });
    expect(writes.map((write) => write.ids)).toEqual([['REV-1', 'REV-2']]);
  });

  it('refuses the whole batch on an invalid row or id', async () => {
    const { store, writes } = memoryStore([]);
    const report = await serviceWith(store).createMissing(
      't1',
      'Demandas',
      [
        { id: 'REV-1', fields: { Descripcion: 'a\u0000b' } },
        { id: 'x'.repeat(201), fields: { Descripcion: 'ok' } },
      ],
      { dryRun: false, source: 'x' },
    );
    expect(report.created).toBe(0);
    expect(report.problems.map((p) => p.row)).toEqual([1, 2]);
    expect(writes).toEqual([]);
  });
});
