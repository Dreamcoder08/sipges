/**
 * A throwaway S3-compatible server for the migrate-legacy differential run (T43): path-style PUT
 * and GET on 127.0.0.1, one directory per bucket. It recomputes every request's SigV4 signature
 * with the API's own `signRequest`, so a Rust request only passes when it signs like TypeScript.
 * Bucket `deny-put` refuses writes and `deny-get` refuses reads. Prints its port on stdout.
 *
 *   node engines/tools-parity/fake-s3.ts <directory>
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, join } from 'node:path';
import { signRequest } from '../../apps/api/src/contexts/evidence/infrastructure/s3-signature.ts';

export const FAKE_S3_CREDENTIALS = { accessKeyId: 'SYNTHETICKEY', secretAccessKey: 'synthetic+secret/key' };
export const FAKE_S3_REGION = 'auto';

const parseAmzDate = (value: string) =>
  new Date(value.replace(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/, '$1-$2-$3T$4:$5:$6Z'));

const header = (value: string | string[] | undefined) => (Array.isArray(value) ? value.join(',') : (value ?? ''));

if (process.argv[2]) {
  const root = process.argv[2];
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const body = Buffer.concat(chunks);
      const path = request.url ?? '/';
      const method = request.method ?? 'GET';
      const payloadHash = header(request.headers['x-amz-content-sha256']);
      const contentType = header(request.headers['content-type']);
      const amz = header(request.headers['x-amz-date']);
      const expected = signRequest({
        method,
        path,
        host: header(request.headers.host),
        region: FAKE_S3_REGION,
        headers: {
          'x-amz-content-sha256': payloadHash,
          'x-amz-date': amz,
          ...(contentType ? { 'content-type': contentType } : {}),
        },
        payloadHash,
        at: parseAmzDate(amz),
        credentials: FAKE_S3_CREDENTIALS,
      });
      const finish = (status: number, text = '') => {
        response.statusCode = status;
        response.end(text);
      };
      if (expected !== request.headers.authorization) return finish(403, 'signature mismatch');
      if (createHash('sha256').update(body).digest('hex') !== payloadHash)
        return finish(400, 'payload hash mismatch');
      const decoded = path.split('/').map(decodeURIComponent);
      const bucket = decoded[1] ?? '';
      const file = join(root, ...decoded.slice(1));
      if (bucket === `deny-${method.toLowerCase()}`) return finish(500, 'refused');
      if (method === 'PUT') {
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(file, body);
        writeFileSync(`${file}.content-type`, contentType);
        return finish(200);
      }
      if (method !== 'GET') return finish(405);
      try {
        return response.end(readFileSync(file));
      } catch {
        return finish(404, 'missing');
      }
    });
  });
  server.listen(0, '127.0.0.1', () => {
    const address = server.address();
    process.stdout.write(`${typeof address === 'object' && address ? address.port : 0}\n`);
  });
}
