import { beforeEach, expect, it, vi } from 'vitest';
import { del, get, put } from '@vercel/blob';
import { privateBlobStorage } from '../src/blob-storage.ts';

vi.mock('@vercel/blob', () => ({ put: vi.fn(), get: vi.fn(), del: vi.fn() }));
beforeEach(() => vi.clearAllMocks());
const key = '0123456789abcdef01234567/synthetic.txt';

it('writes a deterministic private key and reads exact bytes through the server', async () => {
  const bytes = new Uint8Array([0, 255, 65, 10]);
  const storage = privateBlobStorage();
  await storage.put(key, bytes, 'application/octet-stream');
  expect(put).toHaveBeenCalledWith(
    key,
    Buffer.from(bytes),
    expect.objectContaining({
      access: 'private',
      addRandomSuffix: false,
      allowOverwrite: true,
    }),
  );
  vi.mocked(get).mockResolvedValue({
    statusCode: 200,
    stream: new ReadableStream({
      start(c) {
        c.enqueue(bytes);
        c.close();
      },
    }),
    headers: new Headers(),
    blob: {
      url: 'https://private.example.test/synthetic',
      downloadUrl: 'https://private.example.test/synthetic',
      pathname: key,
      contentType: 'application/octet-stream',
      contentDisposition: 'attachment',
      cacheControl: 'no-store',
      etag: 'synthetic',
      size: bytes.length,
      uploadedAt: new Date(),
    },
  });
  // A different runtime instance accesses the same persistent key.
  expect(await privateBlobStorage().get(key)).toEqual(bytes);
  expect(get).toHaveBeenCalledWith(key, { access: 'private', useCache: false });
  await storage.delete(key);
  expect(del).toHaveBeenCalledWith(key);
});

it('maps absent objects to null and rejects unsafe keys before contacting storage', async () => {
  vi.mocked(get).mockResolvedValue(null);
  const storage = privateBlobStorage();
  expect(await storage.get(key)).toBeNull();
  vi.clearAllMocks();
  for (const unsafe of ['../secret', '0123456789abcdef01234567/../secret', '/absolute']) {
    await expect(storage.put(unsafe, new Uint8Array(), 'application/octet-stream')).rejects.toThrow(
      'Invalid object key',
    );
    await expect(storage.get(unsafe)).rejects.toThrow('Invalid object key');
    await expect(storage.delete(unsafe)).rejects.toThrow('Invalid object key');
  }
  expect(put).not.toHaveBeenCalled();
  expect(get).not.toHaveBeenCalled();
  expect(del).not.toHaveBeenCalled();
});
