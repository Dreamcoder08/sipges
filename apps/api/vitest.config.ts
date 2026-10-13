import { defineConfig } from 'vitest/config';

export default defineConfig({
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
