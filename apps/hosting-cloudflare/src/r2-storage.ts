import type { ObjectStorage } from '../../api/src/contexts/evidence/application/ports.ts';
import type { R2Bucket } from './bindings.ts';

/**
 * Evidence files in a private R2 bucket. Downloads always go through MASCLI's session,
 * project and permission checks; the bucket is never public and no object URL is issued.
 */
export const r2ObjectStorage = (bucket: R2Bucket): ObjectStorage => ({
  async put(key, bytes, contentType) {
    await bucket.put(key, bytes, { httpMetadata: { contentType } });
  },
  async get(key) {
    const object = await bucket.get(key);
    return object ? new Uint8Array(await object.arrayBuffer()) : null;
  },
  async delete(key) {
    await bucket.delete(key);
  },
});
