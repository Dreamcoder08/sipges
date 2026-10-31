import { describe, expect, it } from 'vitest';
import type { R2Bucket } from '../src/bindings.ts';
import { r2ObjectStorage } from '../src/r2-storage.ts';

const memoryBucket = () => {
  const objects = new Map<string, { bytes: Uint8Array; contentType: string | undefined }>();
  const bucket: R2Bucket = {
    async put(key, value, options) {
      objects.set(key, { bytes: value, contentType: options?.httpMetadata?.contentType });
    },
    async get(key) {
      const object = objects.get(key);
      return object ? { arrayBuffer: async () => object.bytes.slice().buffer } : null;
    },
    async delete(key) {
      objects.delete(key);
    },
  };
  return { bucket, objects };
};

describe('r2ObjectStorage', () => {
  it('stores bytes with their content type and reads them back unchanged', async () => {
    const { bucket, objects } = memoryBucket();
    const storage = r2ObjectStorage(bucket);
    const bytes = new Uint8Array([0, 1, 2, 250, 255]);
    await storage.put('t/a.pdf', bytes, 'application/pdf');
    expect(objects.get('t/a.pdf')?.contentType).toBe('application/pdf');
    expect(await storage.get('t/a.pdf')).toEqual(bytes);
  });

  it('returns null for a missing object and deletes idempotently', async () => {
    const { bucket } = memoryBucket();
    const storage = r2ObjectStorage(bucket);
    expect(await storage.get('missing')).toBeNull();
    await storage.put('t/b.txt', new Uint8Array([1]), 'text/plain');
    await storage.delete('t/b.txt');
    await storage.delete('t/b.txt');
    expect(await storage.get('t/b.txt')).toBeNull();
  });
});
