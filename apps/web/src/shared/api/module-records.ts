import { ModuleRecord } from '@mascli/contracts';
import { z } from 'zod';
import { requestJson } from './client.ts';

/** Follow bounded API pages so lists and charts never silently lose older rows. */
export const fetchModuleRecords = async (
  module: string,
  scope: string,
  search = '',
  signal?: AbortSignal,
) => {
  const records: ModuleRecord[] = [];
  const ids = new Set<string>();
  const limit = 500;
  for (let offset = 0; ; offset += limit) {
    const page = await requestJson(
      `/api/${module}?${new URLSearchParams({ limit: String(limit), offset: String(offset), q: search })}`,
      z.array(ModuleRecord),
      { scope, ...(signal ? { signal } : {}) },
    );
    for (const row of page) {
      if (ids.has(row._id))
        throw new Error(
          'Los registros cambiaron durante la consulta. Reintente para actualizar la lista.',
        );
      ids.add(row._id);
      records.push(row);
    }
    if (page.length < limit) return records;
  }
};
