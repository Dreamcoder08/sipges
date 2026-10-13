import { availableParallelism } from 'node:os';
import { Worker } from 'node:worker_threads';
import type { PdfText } from '../application/index.ts';

type Reply =
  | { readonly id: number; readonly ok: true; readonly value: PdfText }
  | { readonly id: number; readonly ok: false; readonly message: string };

type Pending = {
  readonly resolve: (value: PdfText) => void;
  readonly reject: (error: Error) => void;
  readonly timer: NodeJS.Timeout;
};

type Slot = { worker: Worker | null; readonly pending: Map<number, Pending> };

const WORKER_URL = new URL('./pdf-worker.ts', import.meta.url);

/**
 * pdf.js parses on the calling thread and blocked the event loop for 300-400 ms on a 100-page
 * PDF (docs/benchmarks). Extraction runs in a small pool of worker threads instead. A job
 * that exceeds `timeoutMs` terminates its worker, which also bounds hostile PDFs.
 */
export const createPdfWorkerPool = (
  options: { size?: number; timeoutMs?: number; workerUrl?: URL } = {},
) => {
  const size = Math.max(1, options.size ?? Math.min(2, availableParallelism() - 1));
  const timeoutMs = options.timeoutMs ?? 30_000;
  const slots: Slot[] = Array.from({ length: size }, () => ({ worker: null, pending: new Map() }));
  let nextId = 0;

  const failAll = (slot: Slot, error: Error) => {
    for (const job of slot.pending.values()) {
      clearTimeout(job.timer);
      job.reject(error);
    }
    slot.pending.clear();
    slot.worker = null;
  };

  const start = (slot: Slot) => {
    const worker = new Worker(options.workerUrl ?? WORKER_URL);
    // Idle workers must not keep the process alive.
    worker.unref();
    worker.on('message', (reply: Reply) => {
      const job = slot.pending.get(reply.id);
      if (!job) return;
      slot.pending.delete(reply.id);
      clearTimeout(job.timer);
      if (slot.pending.size === 0) worker.unref();
      if (reply.ok) job.resolve(reply.value);
      else job.reject(new Error(reply.message));
    });
    worker.on('error', (error) => {
      if (slot.worker === worker) failAll(slot, error);
    });
    worker.on('exit', () => {
      if (slot.worker === worker) failAll(slot, new Error('PDF worker stopped'));
    });
    slot.worker = worker;
    return worker;
  };

  return {
    read(bytes: Uint8Array, maxPages: number): Promise<PdfText> {
      const slot = slots.reduce((best, s) => (s.pending.size < best.pending.size ? s : best));
      const worker = slot.worker ?? start(slot);
      const id = (nextId += 1);
      return new Promise<PdfText>((resolve, reject) => {
        const timer = setTimeout(() => {
          if (slot.worker === worker) {
            failAll(slot, new Error('PDF extraction timed out'));
            void worker.terminate();
          }
        }, timeoutMs);
        slot.pending.set(id, { resolve, reject, timer });
        worker.ref();
        // The copy is transferred, so the caller's bytes stay usable.
        const copy = new Uint8Array(bytes);
        worker.postMessage({ id, bytes: copy, maxPages }, [copy.buffer]);
      });
    },
    async close() {
      await Promise.all(
        slots.map(async (slot) => {
          const worker = slot.worker;
          if (!worker) return;
          slot.worker = null;
          failAll(slot, new Error('PDF worker pool closed'));
          await worker.terminate();
        }),
      );
    },
  };
};

export type PdfWorkerPool = ReturnType<typeof createPdfWorkerPool>;
