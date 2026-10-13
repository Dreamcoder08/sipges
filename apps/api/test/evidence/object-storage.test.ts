import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createLocalObjectStorage,
  createS3ObjectStorage,
} from '../../src/contexts/evidence/infrastructure/index.ts';
import { signRequest } from '../../src/contexts/evidence/infrastructure/s3-signature.ts';

const KEY = `${'a'.repeat(24)}/0123456789abcdef_informe.pdf`;

describe('local object storage', () => {
  const dirs: string[] = [];
  afterEach(async () => {
    await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
  });
  const storage = async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mascli-objects-'));
    dirs.push(dir);
    return { dir, storage: createLocalObjectStorage(dir) };
  };

  it('stores, reads and deletes objects without leaving temporary files', async () => {
    const { dir, storage: s } = await storage();
    await s.put(KEY, new Uint8Array([1, 2, 3]), 'application/pdf');
    expect(await s.get(KEY)).toEqual(new Uint8Array([1, 2, 3]));
    expect(await readdir(join(dir, 'a'.repeat(24)))).toEqual(['0123456789abcdef_informe.pdf']);
    await s.delete(KEY);
    await s.delete(KEY);
    expect(await s.get(KEY)).toBeNull();
  });

  it.each(['../escape.pdf', `${'a'.repeat(24)}/../../x`, '/abs/path', `${'a'.repeat(24)}/a/b`])(
    'refuses key %j',
    async (key) => {
      const { storage: s } = await storage();
      await expect(s.put(key, new Uint8Array([1]), 'text/plain')).rejects.toThrow();
    },
  );
});

describe('S3 signature V4', () => {
  it('matches the AWS documentation example (GET Object)', () => {
    const authorization = signRequest({
      method: 'GET',
      path: '/test.txt',
      host: 'examplebucket.s3.amazonaws.com',
      region: 'us-east-1',
      headers: {
        range: 'bytes=0-9',
        'x-amz-content-sha256': 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
        'x-amz-date': '20130524T000000Z',
      },
      payloadHash: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
      at: new Date('2013-05-24T00:00:00Z'),
      credentials: {
        accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
        secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
      },
    });
    expect(authorization).toBe(
      'AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, ' +
        'SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, ' +
        'Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41',
    );
  });
});

describe('S3 object storage', () => {
  const fake = () => {
    const calls: { method: string; url: string; headers: Headers; body?: Uint8Array }[] = [];
    const objects = new Map<string, Uint8Array>();
    const fetch = (async (input: URL | Request | string, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      const headers = new Headers(init?.headers);
      const body = init?.body ? new Uint8Array(init.body as Uint8Array) : undefined;
      calls.push({ method, url, headers, ...(body ? { body } : {}) });
      if (method === 'PUT') {
        objects.set(url, body ?? new Uint8Array());
        return new Response(null, { status: 200 });
      }
      if (method === 'DELETE') {
        objects.delete(url);
        return new Response(null, { status: 204 });
      }
      const found = objects.get(url);
      return found ? new Response(found) : new Response('NoSuchKey', { status: 404 });
    }) as typeof globalThis.fetch;
    return {
      calls,
      storage: createS3ObjectStorage({
        endpoint: 'https://acct.r2.cloudflarestorage.com',
        region: 'auto',
        bucket: 'mascli-evidence',
        credentials: { accessKeyId: 'AK', secretAccessKey: 'SK' },
        fetch,
        now: () => new Date('2026-10-13T12:00:00Z'),
      }),
    };
  };

  it('uses signed path-style requests and maps 404 to null', async () => {
    const { calls, storage } = fake();
    await storage.put(KEY, new Uint8Array([7, 8]), 'application/pdf');
    expect(await storage.get(KEY)).toEqual(new Uint8Array([7, 8]));
    await storage.delete(KEY);
    expect(await storage.get(KEY)).toBeNull();

    const put = calls[0];
    expect(put?.url).toBe(`https://acct.r2.cloudflarestorage.com/mascli-evidence/${KEY}`);
    expect(put?.headers.get('authorization')).toMatch(
      /^AWS4-HMAC-SHA256 Credential=AK\/20261013\/auto\/s3\/aws4_request, SignedHeaders=content-type;host;x-amz-content-sha256;x-amz-date, Signature=[0-9a-f]{64}$/,
    );
    expect(put?.headers.get('x-amz-acl')).toBeNull();
  });

  it('surfaces S3 errors instead of pretending success', async () => {
    const storage = createS3ObjectStorage({
      endpoint: 'https://s3.example.org',
      region: 'us-east-1',
      bucket: 'b',
      credentials: { accessKeyId: 'AK', secretAccessKey: 'SK' },
      fetch: (async () => new Response('AccessDenied', { status: 403 })) as typeof fetch,
    });
    await expect(storage.put(KEY, new Uint8Array([1]), 'text/plain')).rejects.toThrow(
      'S3 PUT failed with 403',
    );
    await expect(storage.get(KEY)).rejects.toThrow('S3 GET failed with 403');
  });
});
