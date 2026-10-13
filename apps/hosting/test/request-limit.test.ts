import { expect, it } from 'vitest';
import app from '../src/index.ts';

it('bounds the entire multipart comparison before opening a database', async () => {
  const form = new FormData();
  for (const name of ['left', 'right']) {
    form.set(name, new Blob([new Uint8Array(2 * 1024 * 1024)]), `${name}.txt`);
  }
  const response = await app.request('/system/document-lab/compare', {
    method: 'POST',
    body: form,
  });
  expect(response.status).toBe(413);
  expect(await response.text()).toContain('4 MiB');
});
