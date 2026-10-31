import { describe, expect, it } from 'vitest';
import {
  documentReader,
  inlineDocumentReader,
} from '../../src/contexts/documents/infrastructure/index.ts';
import { minimalPdf, utf8 } from './fixtures.ts';

/** Cloudflare Workers have no worker threads; the inline reader must read exactly the same. */
describe('inline document reader', () => {
  it('reads the same PDF pages as the worker-thread reader', async () => {
    const pdf = minimalPdf(['Primera pagina del acta', '', 'Tercera pagina con empleo local']);
    const inline = await inlineDocumentReader.readPdf(pdf, 10);
    expect(inline).toEqual(await documentReader.readPdf(pdf, 10));
    expect(JSON.stringify(inline)).toContain('Tercera pagina con empleo local');
  });

  it('stops at the page limit like the worker-thread reader', async () => {
    const pdf = minimalPdf(['Uno', 'Dos', 'Tres']);
    expect(await inlineDocumentReader.readPdf(pdf, 2)).toEqual(
      await documentReader.readPdf(pdf, 2),
    );
  });

  it('rejects a file that is not a PDF', async () => {
    await expect(inlineDocumentReader.readPdf(utf8('%PDF-1.4 not really'), 10)).rejects.toThrow();
  });

  it('shares the DOCX reader', () => {
    expect(inlineDocumentReader.readDocx).toBe(documentReader.readDocx);
  });
});
