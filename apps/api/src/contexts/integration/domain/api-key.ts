/** Machine credentials (docs/adr/0014 §6). Pure: token shape, scopes and payload checks. */

export const KEY_ACCESS = ['read', 'write'] as const;
export type KeyAccess = (typeof KEY_ACCESS)[number];
export const KEY_CLEARANCE = ['limited', 'full'] as const;
export type KeyClearance = (typeof KEY_CLEARANCE)[number];

/** A key as the API knows it once authenticated. */
export type ApiPrincipal = {
  readonly keyId: number;
  readonly tenantId: string;
  readonly name: string;
  readonly access: KeyAccess;
  readonly clearance: KeyClearance;
};

const TOKEN = /^mscli_([a-f0-9]{12})_([A-Za-z0-9_-]{43})$/;

/** `mscli_<prefix>_<secret>`: the prefix finds the row, the secret is compared by hash. */
export const formatToken = (prefix: string, secret: string) => `mscli_${prefix}_${secret}`;

export const parseToken = (token: string): { prefix: string; secret: string } | null => {
  const match = TOKEN.exec(token.trim());
  return match?.[1] && match[2] ? { prefix: match[1], secret: match[2] } : null;
};

/** Reads `Authorization: Bearer <token>`. */
export const bearerToken = (header: string | undefined): string | null =>
  header?.startsWith('Bearer ') ? header.slice(7).trim() : null;

/** Audit actor for writes made with a key; never mistaken for a person's username. */
export const keyActor = (principal: ApiPrincipal) => `api:${principal.name}`.slice(0, 120);

/** Every scoped request names one project; a payload may not point at another (app.py:231). */
export const payloadProject = (payload: Readonly<Record<string, unknown>>): unknown =>
  payload.Proyecto_ID || payload.project_id;
