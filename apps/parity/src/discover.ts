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

const contextName = (file: string) => file.replace(/\.ts$/, '');

/**
 * Loads every context module in `dir`, in context-name order (`sessions` before
 * `sessions-hardening`, which sorting the file names with `.ts` would invert). Adding a context
 * means adding one file; no shared list is edited, so parallel ports do not conflict.
 */
export const loadContexts = async (dir: string): Promise<ContextModule[]> => {
  const files = readdirSync(dir)
    .filter(isContextFile)
    .sort((a, b) => (contextName(a) < contextName(b) ? -1 : 1));
  return Promise.all(
    files.map(async (file) => {
      const mod: Record<string, unknown> = await import(pathToFileURL(join(dir, file)).href);
      if (!Array.isArray(mod.cases))
        throw new Error(`${file} must export \`cases\` (an array of parity cases)`);
      if (mod.seed !== undefined && typeof mod.seed !== 'string')
        throw new Error(`${file}: \`seed\` must be SQL text`);
      return {
        name: contextName(file),
        cases: mod.cases as ParityCase[],
        seed: (mod.seed as string | undefined) ?? '',
      };
    }),
  );
};
