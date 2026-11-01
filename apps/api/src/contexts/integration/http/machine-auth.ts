import type { Context } from 'hono';
import { currentRequestContext } from '../../../platform/request-context.ts';
import {
  type ApiKeyService,
  type ApiPrincipal,
  bearerToken,
  keyActor,
} from '../application/index.ts';

export type MachineAuth =
  | { readonly ok: true; readonly principal: ApiPrincipal; readonly projectId: string }
  | { readonly ok: false; readonly response: Response };

/**
 * Authenticates an API key and makes it the request's actor: record history and audit name
 * `api:<key name>`, and the key's clearance decides whether restricted rows are visible.
 */
export const authenticateKey = async (
  c: Context,
  keys: ApiKeyService,
  options: { write: boolean },
): Promise<MachineAuth> => {
  const principal = await keys.authenticate(bearerToken(c.req.header('authorization')));
  if (!principal) {
    c.header('WWW-Authenticate', 'Bearer realm="sipges"');
    return {
      ok: false,
      response: c.json({ detail: 'Clave de API no válida o revocada' }, 401),
    };
  }
  if (options.write && principal.access !== 'write') {
    return { ok: false, response: c.json({ detail: 'La clave es de solo lectura' }, 403) };
  }
  const context = currentRequestContext();
  if (context) {
    context.actor = keyActor(principal);
    context.clearance = principal.clearance;
  }
  return { ok: true, principal, projectId: principal.tenantId.split('/')[1] ?? '' };
};
