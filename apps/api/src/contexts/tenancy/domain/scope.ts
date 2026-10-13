import { type Result, err, ok } from '@mascli/kernel';

/** A company/project pair; one tenant. */
export type Scope = { readonly companyId: string; readonly projectId: string };

/** Legacy project of the Python installation (app.py bootstrap). */
export const DEFAULT_SCOPE: Scope = { companyId: 'MASCLI', projectId: 'PRJ-SECHURA' };
export const DEFAULT_SCOPE_LABEL = 'Proyecto Sechura (migración)';

const ID_PATTERN = /^[A-Za-z0-9_-]{2,64}$/;
const LABEL_MAX = 120;

export const formatScope = (scope: Scope) => `${scope.companyId}/${scope.projectId}`;

/** Splits at the first slash, like app.py `target.split('/', 1)`. */
export const parseScope = (text: string): Scope | null => {
  const slash = text.indexOf('/');
  if (slash < 0) return null;
  return { companyId: text.slice(0, slash), projectId: text.slice(slash + 1) };
};

export const sameScope = (a: Scope, b: Scope) =>
  a.companyId === b.companyId && a.projectId === b.projectId;

/**
 * app.py enforce_auth step 4: the X-MASCLI-Scope header, then the scope cookie, then the
 * only grant when nothing was requested. Anything not granted resolves to null.
 */
export const resolveScope = (input: {
  header: string | undefined;
  cookie: string | undefined;
  grants: readonly Scope[];
}): Scope | null => {
  const requested = input.header || input.cookie;
  if (!requested) return input.grants.length === 1 ? (input.grants[0] ?? null) : null;
  return input.grants.find((g) => formatScope(g) === requested) ?? null;
};

export type NewTenant = Scope & { readonly label: string; readonly username: string };

/** Rules of app.py:355-361 (create_scope). */
export const validateNewTenant = (
  input: NewTenant,
): Result<NewTenant, 'invalid_ids' | 'reserved'> => {
  if (!ID_PATTERN.test(input.companyId) || !ID_PATTERN.test(input.projectId))
    return err('invalid_ids');
  if (sameScope(input, DEFAULT_SCOPE)) return err('reserved');
  return ok({ ...input, label: input.label.slice(0, LABEL_MAX) });
};
