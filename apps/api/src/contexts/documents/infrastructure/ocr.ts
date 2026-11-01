import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { DocumentReader, TextRecognizer } from '../application/index.ts';

const run = promisify(execFile);

/** A scanned PDF of 100 pages takes minutes on one core; anything longer is abandoned. */
const OCR_TIMEOUT_MS = 5 * 60_000;

/**
 * Runs the local `ocrmypdf` (Tesseract) on a private temporary copy and reads its text
 * sidecar, where pages are separated by form feeds. Nothing leaves the server.
 */
export const ocrmypdfRecognizer = (languages: string): TextRecognizer => ({
  async recognizePdf(bytes) {
    const dir = await mkdtemp(join(tmpdir(), 'sipges-ocr-'));
    try {
      const input = join(dir, 'in.pdf');
      const sidecar = join(dir, 'text.txt');
      await writeFile(input, bytes, { mode: 0o600 });
      await run(
        'ocrmypdf',
        [
          '--skip-text',
          '--quiet',
          '-l',
          languages,
          '--sidecar',
          sidecar,
          input,
          join(dir, 'out.pdf'),
        ],
        { timeout: OCR_TIMEOUT_MS, maxBuffer: 1024 * 1024 },
      );
      return (await readFile(sidecar, 'utf8')).split('\f');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
});

const blank = (pages: readonly string[]) => pages.every((page) => page.trim() === '');

/** Falls back to OCR only when a PDF within the page limit has no text layer at all. */
export const withOcr = (reader: DocumentReader, recognizer: TextRecognizer): DocumentReader => ({
  ...reader,
  async readPdf(bytes, maxPages) {
    const pdf = await reader.readPdf(bytes, maxPages);
    if (pdf.kind !== 'pages' || !blank(pdf.pages)) return pdf;
    return { kind: 'pages', pages: await recognizer.recognizePdf(bytes) };
  },
});
