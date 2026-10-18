import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [react()],
  // MapLibre's worker is an ES module served from our origin (ADR 0017), not a blob: URL.
  worker: { format: 'es' },
  server: {
    port: 5173,
    proxy: {
      // The API owns sessions and cookies; the SPA always talks to it same-origin.
      '/api': 'http://127.0.0.1:8000',
      '/system': 'http://127.0.0.1:8000',
      '/health': 'http://127.0.0.1:8000',
      // GET /login is the SPA's sign-in screen; only the form POST goes to the API.
      '/login': {
        target: 'http://127.0.0.1:8000',
        bypass: (req) => (req.method === 'GET' ? '/index.html' : undefined),
      },
      '/logout': 'http://127.0.0.1:8000',
      '/select-project': 'http://127.0.0.1:8000',
    },
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
  },
});
