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
