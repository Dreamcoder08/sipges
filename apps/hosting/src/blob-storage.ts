import { del, get, put } from '@vercel/blob';
import type { ObjectStorage } from '../../api/src/contexts/evidence/application/index.ts';

/** Private, persistent objects; downloads still pass through SIPGES tenant authorization. */
export const privateBlobStorage = (): ObjectStorage => {
  const check = (key: string) => {
    if (!/^[0-9a-f]{24}\/[A-Za-z0-9._-]+$/.test(key)) throw new Error('Invalid object key');
  };
  return {
    async put(key, bytes, contentType) {
      check(key);
      await put(key, Buffer.from(bytes), {
        access: 'private',
        addRandomSuffix: false,
        allowOverwrite: true,
        contentType,
      });
    },
    async get(key) {
      check(key);
      const result = await get(key, { access: 'private', useCache: false });
      if (!result) return null;
      if (result.statusCode !== 200 || !result.stream) throw new Error('Object read failed');
      return new Uint8Array(await new Response(result.stream).arrayBuffer());
    },
    async delete(key) {
      check(key);
      await del(key);
    },
  };
};
