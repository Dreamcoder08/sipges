import { describe, expect, it } from 'vitest';
import {
  MAX_FINDINGS,
  checkDecision,
  compareFindings,
  docxChunks,
  documentInsights,
  fingerprint,
  pdfChunks,
  recommendationsFor,
  textChunks,
} from '../../src/contexts/documents/domain/index.ts';
import { documentReader, docxRenderer } from '../../src/contexts/documents/infrastructure/index.ts';
import parity from './python-parity.fixture.json' with { type: 'json' };
import { utf8 } from './fixtures.ts';

describe('Python parity (scripts/python-parity/document-lab.py)', () => {
  it('splits text lines like str.splitlines and drops the BOM', () => {
    expect(textChunks(utf8(parity.text_a))).toEqual(parity.chunks_a);
  });

  it('produces the same findings, theme counts and recommendations', () => {
    const { items, themes } = documentInsights(textChunks(utf8(parity.text_a)));
    expect(items).toEqual(parity.items_a);
    expect(items).toHaveLength(MAX_FINDINGS);
    expect(themes).toEqual(parity.themes_a);
    expect(recommendationsFor(themes)).toEqual(parity.recommendations_a);
  });

  it('produces the same comparison candidates in the same order', () => {
    const a = documentInsights(textChunks(utf8(parity.text_a))).items;
    const b = documentInsights(textChunks(utf8(parity.text_b))).items;
    expect(b).toEqual(parity.items_b);
    const { comparisons, total } = compareFindings(a, b);
    expect(total).toBe(parity.total_comparisons);
    expect(comparisons).toEqual(
      parity.comparisons.map((c) => ({
        ...c,
        tipo: 'Coincidencia temática; verificar diferencias entre versiones',
        advertencia: 'No constituye contradicción demostrada ni acuerdo confirmado.',
      })),
    );
  });

  it('reads a python-docx document into the same located chunks', async () => {
    const bytes = Uint8Array.from(Buffer.from(parity.docx_base64, 'base64'));
    expect(docxChunks(await documentReader.readDocx(bytes))).toEqual(parity.docx_chunks);
  });
});

describe('document insights', () => {
  it('skips segments shorter than 20 characters and folds accents in both directions', () => {
    const { items } = documentInsights([
      { location: 'Línea 1', text: 'Mesa corta.' },
      { location: 'Línea 2', text: 'Se convocó a nueva ELECCION de la directiva comunal.' },
    ]);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      id: 'H001',
      ubicacion: 'Línea 2',
      terminos: ['directiva', 'elección'],
    });
  });

  it('cuts excerpts at 480 code points, not UTF-16 units', () => {
    const long = `Acuerdo ${'😀'.repeat(600)}`;
    const [item] = documentInsights([{ location: 'Línea 1', text: long }]).items;
    expect(Array.from(item?.fragmento ?? '')).toHaveLength(480);
  });
});

describe('document sources', () => {
  it('labels PDF pages and skips blank ones', () => {
    expect(pdfChunks([' uno ', '  ', 'tres'])).toEqual([
      { location: 'Página 1', text: 'uno' },
      { location: 'Página 3', text: 'tres' },
    ]);
  });

  it('decodes invalid UTF-8 with replacement characters', () => {
    expect(textChunks(Uint8Array.from([0x61, 0xff, 0x62]))).toEqual([
      { location: 'Línea 1', text: 'a\ufffdb' },
    ]);
  });
});

describe('fingerprints', () => {
  it('keeps distinctive words of five or more ASCII characters', () => {
    expect([...fingerprint('Según el Documento, la Reunión sobre agua y SEGURIDAD 12345')]).toEqual(
      ['reunion', 'seguridad', '12345'],
    );
  });
});

describe('review decisions', () => {
  it('accepts the four statuses and requires a note to corroborate', () => {
    expect(checkDecision('descartado', '')).toEqual({ ok: true, status: 'descartado' });
    expect(checkDecision('aprobado', 'x')).toEqual({ ok: false, error: { kind: 'status' } });
    expect(checkDecision('corroborado_documentalmente', '  ')).toEqual({
      ok: false,
      error: { kind: 'note_required' },
    });
  });
});

describe('DOCX adapters', () => {
  it('round-trips text, line breaks, escaped characters and tables', async () => {
    const bytes = await docxRenderer.render({
      blocks: [
        { kind: 'title', text: 'Informe' },
        { kind: 'paragraph', text: 'Acta & <anexo> "uno"\nsegunda línea' },
        { kind: 'table', header: ['Campo', 'Valor'], rows: [['Plazo', '30 días']] },
      ],
    });
    expect(await documentReader.readDocx(bytes)).toEqual({
      paragraphs: ['Informe', 'Acta & <anexo> "uno"\nsegunda línea'],
      tables: [
        [
          ['Campo', 'Valor'],
          ['Plazo', '30 días'],
        ],
      ],
    });
  });

  it('rejects archives without a Word body', async () => {
    const { zipSync, strToU8 } = await import('fflate');
    const bytes = zipSync({ 'other.xml': strToU8('<x/>') });
    await expect(documentReader.readDocx(bytes)).rejects.toThrow();
  });
});
