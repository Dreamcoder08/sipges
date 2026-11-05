import type { ModuleName, Payload } from '../../contexts/records/application/index.ts';
import { parseScope } from '../../contexts/tenancy/application/index.ts';
import { type BaseMaestraPlan, planBaseMaestra } from './plan.ts';

/** The part of the record store the import needs (contexts/records RecordStore). */
export type BaseMaestraTarget = {
  existing(tenantId: string, module: ModuleName, ids: readonly string[]): Promise<Set<string>>;
  importBatch(
    tenantId: string,
    module: ModuleName,
    items: readonly { id: string; payload: Payload }[],
    note: { action: string; detail: string },
    at: Date,
    options?: { insertOnly: boolean },
  ): Promise<{ created: number; updated: number }>;
};

export type BaseMaestraReport = {
  readonly applied: boolean;
  readonly modules: readonly {
    readonly module: string;
    readonly en_archivo: number;
    readonly nuevos: number;
    readonly ya_existentes: number;
  }[];
  readonly problems: readonly string[];
};

/**
 * Dry run by default. With `apply`, inserts only the missing records, one audited transaction
 * per module («IMPORT · Base Maestra»). Any problem in the file blocks the whole apply, a row
 * naming a project other than the tenant's included. An id without a project (the CLI refuses
 * one) compares whole, so it never lets a foreign row through.
 */
export const importBaseMaestra = async (
  target: BaseMaestraTarget,
  tenantId: string,
  seed: unknown,
  options: { apply: boolean; source: string; now: () => Date },
): Promise<BaseMaestraReport> => {
  const plan: BaseMaestraPlan = planBaseMaestra(seed, parseScope(tenantId)?.projectId ?? tenantId);
  const modules = [];
  const apply = options.apply && plan.problems.length === 0;
  for (const { module, inFile, items } of plan.modules) {
    const existing = items.length
      ? await target.existing(
          tenantId,
          module,
          items.map((item) => item.id),
        )
      : new Set<string>();
    const fresh = items.filter((item) => !existing.has(item.id));
    let created = fresh.length;
    if (apply && fresh.length) {
      const result = await target.importBatch(
        tenantId,
        module,
        fresh,
        {
          action: 'IMPORT',
          detail: `Base Maestra: ${fresh.length} registros nuevos desde ${options.source}`,
        },
        options.now(),
        { insertOnly: true },
      );
      created = result.created;
    }
    modules.push({
      module,
      en_archivo: inFile,
      nuevos: created,
      ya_existentes: items.length - created,
    });
  }
  return { applied: apply, modules, problems: plan.problems };
};
