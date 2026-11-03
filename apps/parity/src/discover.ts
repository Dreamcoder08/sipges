import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { ParityCase } from './types.ts';

/** A context's parity module: its cases and the synthetic SQL they read (may be empty). */
export type ContextModule = {
  readonly name: string;
  readonly cases: readonly ParityCase[];
  readonly seed: string;
};

/** Context modules are every `*.ts` in the directory except `index.ts` and tests. */
const isContextFile = (file: string) =>
  file.endsWith('.ts') && file !== 'index.ts' && !file.endsWith('.test.ts');

/**
 * Loads every context module in `dir`, in file-name order. Adding a context means adding one
 * file; no shared list is edited, so parallel ports do not conflict.
 */
export const loadContexts = async (dir: string): Promise<ContextModule[]> => {
  const files = readdirSync(dir).filter(isContextFile).sort();
  return Promise.all(
    files.map(async (file) => {
      const mod: Record<string, unknown> = await import(pathToFileURL(join(dir, file)).href);
      if (!Array.isArray(mod.cases))
        throw new Error(`${file} must export \`cases\` (an array of parity cases)`);
      if (mod.seed !== undefined && typeof mod.seed !== 'string')
        throw new Error(`${file}: \`seed\` must be SQL text`);
      return {
        name: file.replace(/\.ts$/, ''),
        cases: mod.cases as ParityCase[],
        seed: (mod.seed as string | undefined) ?? '',
      };
    }),
  );
};
