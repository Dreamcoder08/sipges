// In annotation mode React Compiler skips a 'use memo' function that it cannot compile, with no
// warning in the build: the component just renders uncompiled. This test makes that bailout fail CI
// by compiling every annotated file with the options vite.config.ts uses and listening to its logger.
import { transformSync } from '@babel/core';
import reactCompiler from 'babel-plugin-react-compiler';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const src = path.dirname(fileURLToPath(import.meta.url));
const DIRECTIVE = /^\s*['"]use memo['"];?\s*$/gm;

const annotated = readdirSync(src, { recursive: true, encoding: 'utf8' })
  .filter((file) => /\.tsx?$/.test(file) && !/\.test\.tsx?$/.test(file))
  .map((file) => ({ file, code: readFileSync(path.join(src, file), 'utf8') }))
  .map(({ file, code }) => ({ file, code, directives: code.match(DIRECTIVE)?.length ?? 0 }))
  .filter(({ directives }) => directives > 0);

describe('React Compiler', () => {
  it('finds the annotated components', () => {
    expect(annotated.length).toBeGreaterThan(0);
  });

  it.each(annotated)('compiles every annotated function in $file', ({ file, code, directives }) => {
    const outcomes: string[] = [];
    transformSync(code, {
      filename: path.join(src, file),
      babelrc: false,
      configFile: false,
      parserOpts: { plugins: ['typescript', 'jsx'] },
      plugins: [
        [
          reactCompiler,
          {
            compilationMode: 'annotation',
            logger: {
              logEvent: (
                _filename: string | null,
                event: { kind: string; fnName?: string | null },
              ) => {
                if (event.kind === 'CompileSuccess') outcomes.push('compiled');
                else if (event.kind === 'CompileError' || event.kind === 'PipelineError') {
                  outcomes.push(`${event.kind} in ${event.fnName ?? 'an anonymous function'}`);
                }
              },
            },
          },
        ],
      ],
    });
    expect(outcomes).toEqual(Array.from({ length: directives }, () => 'compiled'));
  });
});
