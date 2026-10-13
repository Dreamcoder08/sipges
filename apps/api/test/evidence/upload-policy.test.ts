import { describe, expect, it } from 'vitest';
import { checkUpload, safeUploadName } from '../../src/contexts/evidence/domain/index.ts';
import { linkIntoPayload, projectOf } from '../../src/contexts/evidence/domain/index.ts';

const bytes = (...parts: (string | number[])[]) =>
  new Uint8Array(parts.flatMap((p) => (typeof p === 'string' ? [...Buffer.from(p)] : p)));

describe('safeUploadName (app.py _safe_upload_name)', () => {
  it.each([
    ['Informe Final.PDF', 'Informe-Final.pdf'],
    ['C:\\fakepath\\acta.docx', 'acta.docx'],
    ['../../etc/passwd.txt', 'passwd.txt'],
    ['Reunión con señor Núñez.pdf', 'Reunion-con-senor-Nunez.pdf'],
    ['__.pdf', 'archivo.pdf'],
    ['', 'archivo'],
    ['tab\there.csv', 'tab-here.csv'],
    [`${'a'.repeat(100)}.png`, `${'a'.repeat(80)}.png`],
  ])('%j -> %j', (raw, expected) => {
    expect(safeUploadName(raw)).toBe(expected);
  });
});

describe('checkUpload', () => {
  const MAX = 1024;
  it.each([
    ['a.pdf', bytes('%PDF-1.7\n'), 'application/pdf'],
    ['a.png', bytes([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0]), 'image/png'],
    ['a.jpg', bytes([0xff, 0xd8, 0xff, 0xe0]), 'image/jpeg'],
    ['a.webp', bytes('RIFF', [0, 0, 0, 0], 'WEBPVP8 '), 'image/webp'],
    [
      'a.docx',
      bytes([0x50, 0x4b, 0x03, 0x04, 0]),
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    ],
    ['a.xls', bytes([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]), 'application/vnd.ms-excel'],
    ['a.csv', bytes('\ufeffcol1;col2\r\n1;2\n'), 'text/csv'],
    ['a.txt', bytes('Señal verificada\tcampo'), 'text/plain'],
  ])('accepts %s with the detected type', (name, content, type) => {
    expect(checkUpload(name, content, MAX)).toEqual({
      ok: true,
      value: { safeName: name, contentType: type },
    });
  });

  it.each([
    ['a.pdf', bytes('<html><script>')],
    ['a.png', bytes('%PDF-')],
    ['a.docx', bytes([0xd0, 0xcf, 0x11, 0xe0])],
    ['a.txt', bytes([0x4d, 0x5a, 0x90, 0x00])],
    ['a.csv', bytes([0xff, 0xfe, 0x00])],
  ])('refuses %s whose bytes do not match the extension', (name, content) => {
    expect(checkUpload(name, content, MAX)).toEqual({
      ok: false,
      error: { kind: 'content_mismatch' },
    });
  });

  it('refuses unknown extensions, empty files and oversized files', () => {
    expect(checkUpload('run.exe', bytes('MZ'), MAX)).toMatchObject({
      error: { kind: 'extension' },
    });
    expect(checkUpload('page.html', bytes('<p>'), MAX)).toMatchObject({
      error: { kind: 'extension' },
    });
    expect(checkUpload('a.txt', new Uint8Array(), MAX)).toMatchObject({ error: { kind: 'empty' } });
    expect(checkUpload('a.txt', new Uint8Array(MAX + 1).fill(65), MAX)).toMatchObject({
      error: { kind: 'too_large', maxBytes: MAX },
    });
  });
});

describe('record link (app.py upload_evidence)', () => {
  it('appends to Adjuntos and sets the module-specific file field', () => {
    const link = { id: 'ADJ-1', fileName: 'f.pdf', documentType: 'Acta', verification: 'A' };
    expect(linkIntoPayload({ Adjuntos: 'broken' }, 'eventos', link)).toEqual({
      Adjuntos: [{ id: 'ADJ-1', archivo: 'f.pdf', tipo: 'Acta', verificacion: 'A' }],
      'Evidencia/Resultado': 'f.pdf',
    });
    expect(linkIntoPayload({}, 'fuentes', link)).toMatchObject({ Archivo_Fuente: 'f.pdf' });
    expect(linkIntoPayload({}, 'actores', link)).not.toHaveProperty('Archivo_Fuente');
  });

  it('takes the project from the record, else from the active scope', () => {
    expect(projectOf({ Proyecto_ID: 'P9', Proyecto: 'Nueve' }, 'X')).toEqual({
      projectId: 'P9',
      projectName: 'Nueve',
    });
    expect(projectOf({}, 'PRJ-SECHURA')).toEqual({
      projectId: 'PRJ-SECHURA',
      projectName: 'Proyecto Sechura',
    });
    expect(projectOf({}, 'NORTE')).toEqual({ projectId: 'NORTE', projectName: '' });
  });
});
