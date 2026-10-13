import { http, HttpResponse } from 'msw';
import { expect, it, vi } from 'vitest';
import { server } from '../../test/server.ts';
import { downloadFile } from './download.ts';

it('downloads scoped binary bytes and cleans the temporary URL', async () => {
  let scope: string | null = null;
  server.use(
    http.get('/export.bin', ({ request }) => {
      scope = request.headers.get('X-MASCLI-Scope');
      return new HttpResponse('synthetic bytes');
    }),
  );
  const create = vi.fn((_blob: Blob) => 'blob:synthetic');
  const revoke = vi.fn();
  vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: create, revokeObjectURL: revoke }));
  const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
  await downloadFile('A/B', '/export.bin', 'report.bin');
  expect(scope).toBe('A/B');
  const blob = create.mock.calls[0]?.[0];
  if (!blob) throw new Error('No binary download generated');
  // Fetch returns a native Blob on Node 22, while Node 24/MSW can return jsdom's.
  // Read each with its own implementation instead of crossing DOM/native realms.
  const bytes =
    typeof blob.text === 'function'
      ? await blob.text()
      : await new Promise((resolve) => {
          const reader = new FileReader();
          reader.onload = () => resolve(reader.result);
          reader.readAsText(blob);
        });
  expect(bytes).toBe('synthetic bytes');
  expect(click).toHaveBeenCalledOnce();
  expect(revoke).toHaveBeenCalledWith('blob:synthetic');
  expect(document.querySelector('a[download]')).toBeNull();
  click.mockRestore();
});

it('does not offer an error response as a download', async () => {
  server.use(
    http.get('/denied.bin', () => HttpResponse.json({ detail: 'Sin permiso' }, { status: 403 })),
  );
  await expect(downloadFile('A/B', '/denied.bin', 'report.bin')).rejects.toMatchObject({
    status: 403,
  });
});
