import {
  type ModuleName,
  type Payload,
  recordIdFor,
  validatePayload,
  withTenantProject,
} from './modules.ts';

export const MAX_IMPORT_ROWS = 2000;

/** Administration modules keep their own guarded routes and are never bulk-imported. */
const NOT_IMPORTABLE: ReadonlySet<ModuleName> = new Set(['Usuarios', 'Roles', 'Proyectos']);
export const isImportable = (module: ModuleName) => !NOT_IMPORTABLE.has(module);
export const MAX_IMPORT_VALUE = 10_000;

export type ImportProblem = { readonly row: number; readonly message: string };
export type ImportItem = { readonly row: number; readonly id: string; readonly payload: Payload };

/**
 * Turns spreadsheet rows (already mapped to field names) into records to merge: values are
 * trimmed, blank cells are skipped (they never erase stored data), and each row gets the
 * module's id rule. Rows are numbered from 1 as in the source file, header excluded. With a
 * `projectId`, rows take the tenant's project and a row naming another one is a problem.
 */
export const planImport = (
  module: ModuleName,
  rows: readonly Readonly<Record<string, string>>[],
  randomHex: (length: number) => string,
  projectId?: string,
): { items: ImportItem[]; problems: ImportProblem[] } => {
  const items: ImportItem[] = [];
  const problems: ImportProblem[] = [];
  const seen = new Map<string, number>();
  rows.forEach((raw, index) => {
    const row = index + 1;
    const payload: Record<string, string> = {};
    for (const [field, value] of Object.entries(raw)) {
      const text = value.trim();
      if (!field.trim() || !text) continue;
      payload[field.trim()] = text;
    }
    const keys = Object.keys(payload);
    if (keys.length === 0) return;
    if (
      keys.some((k) => k.includes('\u0000')) ||
      Object.values(payload).some((v) => v.includes('\u0000'))
    ) {
      problems.push({ row, message: 'Contiene caracteres NUL' });
      return;
    }
    if (Object.values(payload).some((v) => v.length > MAX_IMPORT_VALUE)) {
      problems.push({ row, message: `Un valor supera ${MAX_IMPORT_VALUE} caracteres` });
      return;
    }
    const invalid = validatePayload(module, payload);
    if (invalid) {
      problems.push({ row, message: `${invalid.field}: ${invalid.message}` });
      return;
    }
    const owned = projectId ? withTenantProject(module, payload, projectId) : null;
    if (owned && !owned.ok) {
      problems.push({ row, message: `${owned.field}: ${owned.message}` });
      return;
    }
    const id = recordIdFor(module, payload, randomHex);
    const previous = seen.get(id);
    if (previous !== undefined) {
      problems.push({ row, message: `El código ${id} ya aparece en la fila ${previous}` });
      return;
    }
    seen.set(id, row);
    items.push({ row, id, payload: owned ? owned.payload : payload });
  });
  return { items, problems };
};
