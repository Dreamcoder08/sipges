import { defineConfig } from 'vitest/config';

export default defineConfig({
  // pnpm peer variants must not split the runner and imported cleanup hooks.
  resolve: { dedupe: ['vitest'] },
  test: {
    // HTTP tests run real Argon2id hashing (OWASP parameters) against in-process PostgreSQL.
    testTimeout: 20_000,
    // Each PGlite instance owns a WASM PostgreSQL heap. Bound concurrent heaps,
    // rather than increasing Node memory and masking unclosed fixtures.
    maxWorkers: 1,
    fileParallelism: false,
    sequence: { concurrent: false },
    hookTimeout: 20_000,
  },
});
