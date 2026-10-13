import { parentPort } from 'node:worker_threads';

// Test double: never answers, or exits on request, to exercise the pool's failure paths.
parentPort?.on('message', (job: { maxPages: number }) => {
  if (job.maxPages === 0) process.exit(3);
});
