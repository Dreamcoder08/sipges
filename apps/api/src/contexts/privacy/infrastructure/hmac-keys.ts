import { createHmac } from 'node:crypto';
import type { PseudonymKeys } from '../application/index.ts';

/**
 * One key per project, derived from SIPGES_DATA_KEY (docs/adr/0030): HMAC-SHA256 of a purpose
 * label and the project, so the data key itself never keys a hash and another project's
 * pseudonyms cannot be computed from this one's.
 */
export const createPseudonymKeys = (dataKey: Buffer): PseudonymKeys => {
  const derived = new Map<string, Buffer>();
  const keyFor = (tenantId: string) => {
    let key = derived.get(tenantId);
    if (!key) {
      key = createHmac('sha256', dataKey).update(`sipges:pseudonym:v1:${tenantId}`).digest();
      derived.set(tenantId, key);
    }
    return key;
  };
  return {
    macFor: (tenantId) => {
      const key = keyFor(tenantId);
      return (message) => createHmac('sha256', key).update(message).digest('hex');
    },
  };
};
