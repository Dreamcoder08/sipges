import { createHash, createHmac } from 'node:crypto';

/**
 * AWS Signature Version 4 for S3-compatible APIs (AWS S3, Cloudflare R2, MinIO, Backblaze B2).
 * Implemented directly on node:crypto to avoid an SDK dependency; verified against the
 * "GET Object" example of the AWS SigV4 documentation in the tests.
 */

export type S3Credentials = { readonly accessKeyId: string; readonly secretAccessKey: string };

export const sha256Hex = (data: string | Uint8Array) =>
  createHash('sha256').update(data).digest('hex');

const hmac = (key: string | Buffer, data: string) =>
  createHmac('sha256', key).update(data).digest();

/** RFC 3986 encoding as S3 expects it for each path segment. */
export const encodeSegment = (segment: string) =>
  encodeURIComponent(segment).replace(
    /[!'()*]/g,
    (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`,
  );

export const amzDate = (at: Date) =>
  at
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}/, '');

export type SignInput = {
  readonly method: string;
  /** Already-encoded absolute path, e.g. `/bucket/key`. */
  readonly path: string;
  readonly host: string;
  readonly region: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly payloadHash: string;
  readonly at: Date;
  readonly credentials: S3Credentials;
};

/** Returns the Authorization header value; `headers` must include every header to sign. */
export const signRequest = (input: SignInput): string => {
  const date = amzDate(input.at);
  const day = date.slice(0, 8);
  const scope = `${day}/${input.region}/s3/aws4_request`;
  const headers = Object.entries({ ...input.headers, host: input.host })
    .map(([name, value]) => [name.toLowerCase(), value.trim().replace(/\s+/g, ' ')] as const)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const signedHeaders = headers.map(([name]) => name).join(';');
  const canonicalRequest = [
    input.method,
    input.path,
    '',
    ...headers.map(([name, value]) => `${name}:${value}`),
    '',
    signedHeaders,
    input.payloadHash,
  ].join('\n');
  const stringToSign = ['AWS4-HMAC-SHA256', date, scope, sha256Hex(canonicalRequest)].join('\n');
  const key = ['s3', 'aws4_request'].reduce(
    (k, part) => hmac(k, part),
    hmac(hmac(`AWS4${input.credentials.secretAccessKey}`, day), input.region),
  );
  const signature = createHmac('sha256', key).update(stringToSign).digest('hex');
  return `AWS4-HMAC-SHA256 Credential=${input.credentials.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
};
