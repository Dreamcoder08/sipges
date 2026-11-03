// Bearer-token check for the measurement endpoint, compared in constant time.
const encoder = new TextEncoder();
const PREFIX = "Bearer ";

export type TimingSafeEqual = (a: ArrayBufferView, b: ArrayBufferView) => boolean;

export function isAuthorized(header: string | null, token: string | undefined, equal: TimingSafeEqual): boolean {
  if (!token || !header?.startsWith(PREFIX)) {
    return false; // fail closed when the secret is missing
  }
  const given = encoder.encode(header.slice(PREFIX.length));
  const expected = encoder.encode(token);
  if (given.byteLength !== expected.byteLength) {
    equal(expected, expected); // keep the timing independent of the mismatch
    return false;
  }
  return equal(given, expected);
}
