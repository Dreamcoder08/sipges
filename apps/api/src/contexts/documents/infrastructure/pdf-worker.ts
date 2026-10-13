import { parentPort } from 'node:worker_threads';
import { extractPdfText } from './pdf-text.ts';

/** Worker-thread entry: one PDF extraction per message, answered with the same id. */
type Job = { readonly id: number; readonly bytes: Uint8Array; readonly maxPages: number };

parentPort?.on('message', (job: Job) => {
  extractPdfText(job.bytes, job.maxPages).then(
    (value) => parentPort?.postMessage({ id: job.id, ok: true, value }),
    (error: unknown) =>
      parentPort?.postMessage({
        id: job.id,
        ok: false,
        message: error instanceof Error ? error.message : 'PDF extraction failed',
      }),
  );
});
