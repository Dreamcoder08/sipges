import { describe, expect, it } from 'vitest';
import type { DocumentReader, PdfText } from '../../src/contexts/documents/application/index.ts';
import { withOcr } from '../../src/contexts/documents/infrastructure/index.ts';

const readerReturning = (pdf: PdfText): DocumentReader => ({
  readPdf: async () => pdf,
  readDocx: async () => ({ paragraphs: [], tables: [] }),
});

describe('OCR fallback', () => {
  it('recognizes only PDFs without any text layer', async () => {
    const calls: number[] = [];
    const recognizer = {
      recognizePdf: async (bytes: Uint8Array) => {
        calls.push(bytes.length);
        return ['Acta sintética escaneada', ''];
      },
    };
    const scanned = withOcr(readerReturning({ kind: 'pages', pages: [' ', '\n'] }), recognizer);
    expect(await scanned.readPdf(new Uint8Array(3), 100)).toEqual({
      kind: 'pages',
      pages: ['Acta sintética escaneada', ''],
    });

    const digital = withOcr(readerReturning({ kind: 'pages', pages: ['texto', ''] }), recognizer);
    expect(await digital.readPdf(new Uint8Array(3), 100)).toEqual({
      kind: 'pages',
      pages: ['texto', ''],
    });
    const huge = withOcr(readerReturning({ kind: 'too_many_pages' }), recognizer);
    expect(await huge.readPdf(new Uint8Array(3), 100)).toEqual({ kind: 'too_many_pages' });
    expect(calls).toEqual([3]);
  });
});
