import { File as NodeFile } from 'node:buffer';
import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterAll, afterEach, beforeAll } from 'vitest';
import { server } from './server.ts';

// Fetch/MSW run in Node while the DOM runs in jsdom. Use the same binary primitives
// as Node's fetch so multipart bodies retain their bytes and can be decoded by handlers.
const nativeForm = await new Response('', {
  headers: { 'content-type': 'application/x-www-form-urlencoded' },
}).formData();
globalThis.FormData = nativeForm.constructor as typeof FormData;
globalThis.File = NodeFile as unknown as typeof File;

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
