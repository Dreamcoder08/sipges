import { readFileSync } from 'node:fs';
import type { ParityCase } from '../types.ts';

/**
 * PDF reading (T57): pdf.js on Node against pdf.js in WebAssembly on Go. The same synthetic files
 * go to both APIs, so the findings, the 422 answers and the page limit must match byte for byte.
 * Files come from apps/api-go/internal/platform/doctext/testdata/pdf (spikes/pdf-text).
 */
const fixture = (name: string) =>
  readFileSync(
    new URL(`../../../api-go/internal/platform/doctext/testdata/pdf/${name}.pdf`, import.meta.url),
  );

const BOUNDARY = 'ParityPdfBoundary7y';
const HEADERS = { 'content-type': `multipart/form-data; boundary=${BOUNDARY}` };

const part = (field: string, name: string, bytes: Buffer) =>
  Buffer.concat([
    Buffer.from(
      `--${BOUNDARY}\r\nContent-Disposition: form-data; name="${field}"; filename="${name}"\r\nContent-Type: application/pdf\r\n\r\n`,
      'latin1',
    ),
    bytes,
    Buffer.from('\r\n', 'latin1'),
  ]);

const multipart = (...parts: Buffer[]) =>
  Buffer.concat([...parts, Buffer.from(`--${BOUNDARY}--\r\n`, 'latin1')]).toString('base64');

const upload = (
  route: 'analyze' | 'compare' | 'report.docx',
  label: string,
  body: string,
): ParityCase => ({
  name: `pdf ${route}: ${label}`,
  method: 'POST',
  path: `/system/document-lab/${route}`,
  auth: 'admin',
  sameOrigin: true,
  headers: HEADERS,
  body: { base64: body },
  ...(route === 'report.docx' ? {} : { normalize: ['generated_at'] }),
});

const analyze = (name: string) =>
  upload('analyze', name, multipart(part('file', `${name}.pdf`, fixture(name))));

export const cases: readonly ParityCase[] = [
  // Text, order, accents, tables, columns, rotation and other producers.
  analyze('01-plain-helvetica'),
  analyze('02-embedded-ttf-noto'),
  analyze('05-two-columns'),
  analyze('07-table-grid'),
  analyze('08-hyphen-breaks'),
  analyze('11-type3-font'),
  analyze('12-accents-winansi'),
  analyze('14-letter-spaced'),
  analyze('17-form-and-link'),
  analyze('18-text-rotated-90'),
  analyze('20-chrome-tagged'),
  analyze('22-chrome-table'),
  analyze('23-chrome-sans-ligatures'),
  analyze('25-page-rotate-90'),
  analyze('52-encrypted-owner-only-rc4'),
  analyze('53-encrypted-owner-only-aes128'),
  analyze('64-bad-no-xref'),
  // no_text, 422.
  analyze('30-scanned-image-only'),
  analyze('68-bad-count-lie'),
  // Unreadable, 422.
  analyze('50-encrypted-user-password'),
  analyze('60-bad-not-a-pdf'),
  analyze('62-bad-truncated-half'),
  analyze('65-bad-corrupt-stream'),
  analyze('67-bad-page-tree-loop'),
  // More than 100 pages, 413.
  analyze('71-large-101-pages'),
  upload(
    'compare',
    'two PDFs',
    multipart(
      part('file_a', 'a.pdf', fixture('01-plain-helvetica')),
      part('file_b', 'b.pdf', fixture('20-chrome-tagged')),
    ),
  ),
  upload(
    'compare',
    'one scanned file',
    multipart(
      part('file_a', 'a.pdf', fixture('01-plain-helvetica')),
      part('file_b', 'b.pdf', fixture('30-scanned-image-only')),
    ),
  ),
  upload(
    'compare',
    'one broken file',
    multipart(
      part('file_a', 'a.pdf', fixture('60-bad-not-a-pdf')),
      part('file_b', 'b.pdf', fixture('01-plain-helvetica')),
    ),
  ),
];

export const seed = '';
