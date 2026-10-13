import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterAll, afterEach, beforeAll } from 'vitest';
import { server } from './server.ts';

// The app calls the API with same-origin relative paths; Node's fetch needs an absolute URL.
const nodeFetch = globalThis.fetch;
globalThis.fetch = (input, init) =>
  nodeFetch(typeof input === 'string' ? new URL(input, window.location.href) : input, init);

// jsdom does not implement scrolling; the router restores scroll on navigation.
window.scrollTo = () => undefined;

beforeAll(() => server.listen({ onUnhandledFrame: 'error' }));
afterEach(() => {
  cleanup();
  server.resetHandlers();
  window.history.replaceState(null, '', '/');
});
afterAll(() => server.close());
