import type { ModuleRecord } from '@sipges/contracts';

/** A supplied name is not proof of corroboration; generated placeholders are still evidence. */
export const isPendingActorIdentity = (row: ModuleRecord): boolean => {
  const name = String(row['Nombre_Actor/Organizacion'] || row.Nombre || '').trim();
  return !name || /^Por identificar(?:\s*\(|$)/i.test(name);
};
