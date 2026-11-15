/// <reference types="node" />
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { count, plural } from './plural.ts';

// functional-10 T4 (F12): counts agree with their noun; no «registro(s)».
describe('plural', () => {
  it('picks the singular for one and the plural for zero or more than one', () => {
    expect(plural(1, 'registro', 'registros')).toBe('registro');
    expect(plural(0, 'registro', 'registros')).toBe('registros');
    expect(plural(2, 'día', 'días')).toBe('días');
  });

  it('writes the count with its noun phrase', () => {
    expect(count(1, 'registro', 'registros')).toBe('1 registro');
    expect(count(53, 'registro', 'registros')).toBe('53 registros');
    expect(count(28, 'día', 'días')).toBe('28 días');
    expect(count(1, 'día', 'días')).toBe('1 día');
    expect(count(1, 'señal documentada', 'señales documentadas')).toBe('1 señal documentada');
    expect(count(48, 'señal documentada', 'señales documentadas')).toBe('48 señales documentadas');
    expect(count(1, 'archivo', 'archivos')).toBe('1 archivo');
    expect(count(2, 'narrativa', 'narrativas')).toBe('2 narrativas');
    expect(count(0, 'registro', 'registros')).toBe('0 registros');
    expect(count(12345, 'registro', 'registros')).toBe('12.345 registros');
  });
});

/** Every UI source file: components, models and helpers, not their tests. */
const sources = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sources(path);
    return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [path] : [];
  });

it('leaves no «(s)», «(es)» or «(as)» plural in any UI string', () => {
  // Vitest runs from the package directory (`pnpm --filter @sipges/web test`).
  const root = join(process.cwd(), 'src');
  // A letter directly before the parenthesis: «registro(s)», «concesión(es)», «activa(s)»; a call
  // on a variable named `s` (`key(s) ===`, `resolved(s),`) is code, not copy.
  const optional = /\p{L}\((?:s|es|as|os)\)(?!\s*(?:,|===|=>|\)))/u;
  const found = sources(root).flatMap((file) =>
    readFileSync(file, 'utf8')
      .split('\n')
      .flatMap((line, index) =>
        optional.test(line) ? [`${relative(root, file)}:${index + 1}: ${line.trim()}`] : [],
      ),
  );
  expect(found).toEqual([]);
});
