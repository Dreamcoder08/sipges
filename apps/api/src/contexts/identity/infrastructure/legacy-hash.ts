/** A `pbkdf2_sha256$<iterations>$<saltHex>$<digestHex>` hash produced by app.py. */
export type LegacyHash = {
  readonly iterations: number;
  readonly salt: Uint8Array;
  readonly digest: Uint8Array;
};

const HEX = /^(?:[0-9a-f]{2})+$/;

const fromHex = (hex: string) =>
  Uint8Array.from(hex.match(/../g) ?? [], (byte) => Number.parseInt(byte, 16));

/** The parsed legacy hash, or null for anything that is not exactly that format. */
export const parseLegacyHash = (stored: string): LegacyHash | null => {
  const [algorithm, iterations, salt, digest, ...rest] = stored.split('$');
  if (algorithm !== 'pbkdf2_sha256' || rest.length > 0 || !salt || !digest) return null;
  if (!/^\d{1,7}$/.test(iterations ?? '') || !HEX.test(salt) || !HEX.test(digest)) return null;
  // Zero iterations is not a hash: PBKDF2 would throw, and a login must fail, not error.
  if (Number(iterations) < 1) return null;
  return { iterations: Number(iterations), salt: fromHex(salt), digest: fromHex(digest) };
};

/** Compares two digests in time independent of where they differ. */
export const sameDigest = (a: Uint8Array, b: Uint8Array) => {
  if (a.length !== b.length) return false;
  let difference = 0;
  for (let i = 0; i < a.length; i++) difference |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return difference === 0;
};
