import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      // The API owns sessions and cookies; the SPA always talks to it same-origin.
      '/api': 'http://127.0.0.1:8000',
      '/system': 'http://127.0.0.1:8000',
      '/health': 'http://127.0.0.1:8000',
      '/login': 'http://127.0.0.1:8000',
      '/logout': 'http://127.0.0.1:8000',
      '/select-project': 'http://127.0.0.1:8000',
    },
  },
  test: {
    environment: 'jsdom',
  },
});
