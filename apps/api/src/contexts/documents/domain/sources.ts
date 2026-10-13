import type { TextChunk } from './insights.ts';

/** Readable document kinds by extension (app.py `doc_extract`). */
export const DOCUMENT_KINDS = {
  '.pdf': 'pdf',
  '.docx': 'docx',
  '.txt': 'text',
  '.md': 'text',
} as const;

export type DocumentKind = (typeof DOCUMENT_KINDS)[keyof typeof DOCUMENT_KINDS];

export const documentKindOf = (extension: string): DocumentKind | undefined =>
  Object.hasOwn(DOCUMENT_KINDS, extension)
    ? DOCUMENT_KINDS[extension as keyof typeof DOCUMENT_KINDS]
    : undefined;

export const MAX_PDF_PAGES = 100;

/** Text of a Word body: top-level paragraphs (empty ones included) and table rows of cells. */
export type DocxContent = {
  readonly paragraphs: readonly string[];
  readonly tables: readonly (readonly (readonly string[])[])[];
};

const strip = (text: string) => text.trim();

export const pdfChunks = (pages: readonly string[]): TextChunk[] =>
  pages.flatMap((page, i) => {
    const text = strip(page);
    return text ? [{ location: `Página ${i + 1}`, text }] : [];
  });

export const docxChunks = ({ paragraphs, tables }: DocxContent): TextChunk[] => [
  ...paragraphs.flatMap((paragraph, i) => {
    const text = strip(paragraph);
    return text ? [{ location: `Párrafo ${i + 1}`, text }] : [];
  }),
  ...tables.flatMap((rows, ti) =>
    rows.flatMap((cells, ri) => {
      const text = cells.map(strip).join(' | ');
      return text.replace(/^[ |]+|[ |]+$/g, '')
        ? [{ location: `Tabla ${ti + 1}, fila ${ri + 1}`, text }]
        : [];
    }),
  ),
];

/** Python `str.splitlines()` boundaries. */
// eslint-disable-next-line no-control-regex
const LINE_BREAK = /\r\n|[\n\r\u000b\u000c\u001c\u001d\u001e\u0085\u2028\u2029]/u;

/** UTF-8 with optional BOM; invalid bytes become U+FFFD (`decode('utf-8-sig', 'replace')`). */
export const textChunks = (bytes: Uint8Array): TextChunk[] =>
  new TextDecoder('utf-8')
    .decode(bytes)
    .split(LINE_BREAK)
    .flatMap((line, i) => {
      const text = strip(line);
      return text ? [{ location: `Línea ${i + 1}`, text }] : [];
    });
