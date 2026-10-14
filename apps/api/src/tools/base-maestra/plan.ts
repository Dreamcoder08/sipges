import { createHash } from 'node:crypto';
import {
  type ModuleName,
  type Payload,
  RECORD_MODULES,
  isImportable,
  validatePayload,
} from '../../contexts/records/application/index.ts';

/**
 * The prototype loaded `data/seed.json` («Base Maestra octubre 2026») into an empty database
 * (app.py:125-134). This plans the same load into one PostgreSQL tenant, insert-only:
 * records already present are never replaced, so it can be re-run and never overwrites edits.
 */
export type BaseMaestraPlan = {
  readonly modules: readonly {
    readonly module: ModuleName;
    readonly inFile: number;
    readonly items: readonly { readonly id: string; readonly payload: Payload }[];
  }[];
  /** Codes and positions only; never record values. */
  readonly problems: readonly string[];
};

const ID_FIELDS: Partial<Record<ModuleName, string>> = {
  Eventos: 'ID_Evento',
  Actores: 'ID_Actor',
  Demandas: 'ID_Demanda',
  Compromisos: 'ID_Compromiso',
  Narrativas: 'ID_Narrativa',
  Fuentes: 'ID_Fuente',
  Indicadores: 'Codigo',
  Alertas: 'ID_Alerta',
  Acciones: 'ID_Accion',
};
const PREFIXES: Partial<Record<ModuleName, string>> = {
  Eventos: 'EV',
  Actores: 'A',
  Demandas: 'D',
  Alertas: 'AL',
  Fuentes: 'F',
};
const KNOWN = new Map(RECORD_MODULES.map(({ module }) => [module as string, module]));

/** Stable JSON (sorted keys) so the same row always gets the same id. */
const canonical = (value: unknown): string =>
  Array.isArray(value)
    ? `[${value.map(canonical).join(',')}]`
    : value && typeof value === 'object'
      ? `{${Object.keys(value)
          .sort()
          .map(
            (key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`,
          )
          .join(',')}}`
      : JSON.stringify(value);

/**
 * app.py rid_for keeps the module id field; rows without one got a random id there. Here they
 * get `<prefix>-<8 hex of sha256(module + row)>`, so re-running the import skips them.
 */
export const baseMaestraId = (module: ModuleName, payload: Payload) => {
  const key = ID_FIELDS[module];
  const value = key ? payload[key] : undefined;
  if (value !== undefined && value !== null && value !== '' && value !== 0) return String(value);
  const prefix = PREFIXES[module] ?? module.slice(0, 3).toUpperCase();
  const digest = createHash('sha256')
    .update(`${module}\n${canonical(payload)}`)
    .digest('hex');
  return `${prefix}-${digest.slice(0, 8).toUpperCase()}`;
};

export const planBaseMaestra = (seed: unknown): BaseMaestraPlan => {
  if (!seed || typeof seed !== 'object' || Array.isArray(seed))
    return { modules: [], problems: ['El archivo no es un objeto {Módulo: [registros]}'] };
  const modules: BaseMaestraPlan['modules'][number][] = [];
  const problems: string[] = [];
  for (const [name, rows] of Object.entries(seed)) {
    const module = KNOWN.get(name);
    if (!module) {
      problems.push(`Módulo desconocido: ${name}`);
      continue;
    }
    // Users, roles and projects are administered in the app (app.py seeded demo ones).
    if (!isImportable(module)) continue;
    if (!Array.isArray(rows)) {
      problems.push(`${name}: se esperaba una lista`);
      continue;
    }
    const items: { id: string; payload: Payload }[] = [];
    const seen = new Map<string, number>();
    rows.forEach((row: unknown, index) => {
      const position = `${name}[${index}]`;
      if (!row || typeof row !== 'object' || Array.isArray(row)) {
        problems.push(`${position}: no es un objeto`);
        return;
      }
      const payload = row as Payload;
      if (JSON.stringify(payload).includes('\\u0000')) {
        problems.push(`${position}: contiene caracteres NUL`);
        return;
      }
      const invalid = validatePayload(module, payload);
      if (invalid) {
        problems.push(`${position}: ${invalid.field} no es un código válido`);
        return;
      }
      const id = baseMaestraId(module, payload);
      const previous = seen.get(id);
      if (previous !== undefined) {
        problems.push(`${position}: el código ${id} repite ${name}[${previous}]`);
        return;
      }
      seen.set(id, index);
      items.push({ id, payload });
    });
    modules.push({ module, inFile: rows.length, items });
  }
  return { modules, problems };
};
