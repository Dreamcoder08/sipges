import { describe, expect, it } from 'vitest';
import { detectDelimiter, parseCsv } from './csv.ts';

describe('parseCsv', () => {
  it('handles quotes, escaped quotes, CRLF and embedded newlines', () => {
    expect(parseCsv('a,b\r\n"x, y","di ""hola""\nadiós"\r\n,\r\n3,4')).toEqual([
      ['a', 'b'],
      ['x, y', 'di "hola"\nadiós'],
      ['3', '4'],
    ]);
  });

  it('detects semicolon and tab delimiters and drops a BOM', () => {
    expect(detectDelimiter('﻿a;b;c\n1,2;3')).toBe(';');
    expect(parseCsv('﻿a;b\n1;2')).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ]);
    expect(parseCsv('a\tb\n1\t2')).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ]);
  });
});
