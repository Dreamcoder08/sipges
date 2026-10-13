import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // HTTP tests run real Argon2id hashing (OWASP parameters) against in-process PostgreSQL.
    testTimeout: 20_000,
  },
});
