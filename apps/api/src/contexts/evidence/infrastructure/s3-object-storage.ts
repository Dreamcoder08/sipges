import type { ObjectStorage } from '../application/ports.ts';
import {
  type S3Credentials,
  amzDate,
  encodeSegment,
  sha256Hex,
  signRequest,
} from './s3-signature.ts';
import { outboundTraceHeaders } from '../../../platform/observability/trace.ts';

export type S3Options = {
  /** Base URL of the S3-compatible API, e.g. `https://<account>.r2.cloudflarestorage.com`. */
  readonly endpoint: string;
  readonly region: string;
  readonly bucket: string;
  readonly credentials: S3Credentials;
  /** Injected for tests; defaults to global fetch. */
  readonly fetch?: typeof fetch;
  readonly now?: () => Date;
};

/**
 * Path-style S3 client limited to the three calls the Evidence context needs. Objects are
 * private (no ACL headers); downloads always go through the API, which checks the tenant.
 */
export const createS3ObjectStorage = (options: S3Options): ObjectStorage => {
  const endpoint = new URL(options.endpoint);
  const doFetch = options.fetch ?? fetch;
  const now = options.now ?? (() => new Date());

  const send = async (method: string, key: string, body?: Uint8Array, contentType?: string) => {
    const path = `/${encodeSegment(options.bucket)}/${key.split('/').map(encodeSegment).join('/')}`;
    const at = now();
    const payloadHash = sha256Hex(body ?? '');
    const headers: Record<string, string> = {
      'x-amz-content-sha256': payloadHash,
      'x-amz-date': amzDate(at),
      ...(contentType ? { 'content-type': contentType } : {}),
    };
    const authorization = signRequest({
      method,
      path,
      host: endpoint.host,
      region: options.region,
      headers,
      payloadHash,
      at,
      credentials: options.credentials,
    });
    return doFetch(new URL(path, endpoint), {
      method,
      // traceparent is not signed, so it may change without breaking SigV4.
      headers: { ...headers, authorization, ...outboundTraceHeaders() },
      ...(body ? { body } : {}),
    });
  };

  const fail = async (action: string, response: Response) => {
    const text = (await response.text().catch(() => '')).slice(0, 300);
    return new Error(`S3 ${action} failed with ${response.status}: ${text}`);
  };

  return {
    async put(key, bytes, contentType) {
      const response = await send('PUT', key, bytes, contentType);
      if (!response.ok) throw await fail('PUT', response);
    },

    async get(key) {
      const response = await send('GET', key);
      if (response.status === 404) return null;
      if (!response.ok) throw await fail('GET', response);
      return new Uint8Array(await response.arrayBuffer());
    },

    async delete(key) {
      const response = await send('DELETE', key);
      if (!response.ok && response.status !== 404) throw await fail('DELETE', response);
    },
  };
};
