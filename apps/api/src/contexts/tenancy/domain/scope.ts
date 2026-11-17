import { type Result, err, ok } from '@sipges/kernel';

/** A company/project pair; one tenant. */
export type Scope = { readonly companyId: string; readonly projectId: string };

/** Legacy project of the Python installation (app.py bootstrap). */
export const DEFAULT_SCOPE: Scope = { companyId: 'SIPGES', projectId: 'PRJ-SECHURA' };
export const DEFAULT_SCOPE_LABEL = 'Proyecto principal';

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
 * app.py enforce_auth step 4: the X-SIPGES-Scope header, then the scope cookie, then the
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

/** The audit row of a rename, in the renamed project's own trail. */
export const RENAME_AUDIT = { module: 'Proyectos', action: 'RENAME' } as const;

/**
 * A project's new display name: trimmed, refused when nothing is left, then cut to LABEL_MAX
 * UTF-16 code units as creation cuts it.
 */
export const validateLabel = (label: string): Result<string, 'invalid_label'> => {
  const trimmed = label.trim();
  return trimmed ? ok(trimmed.slice(0, LABEL_MAX)) : err('invalid_label');
};

export const renameDetail = (previous: string, label: string, by: string) =>
  `Proyecto renombrado de «${previous}» a «${label}» por ${by}`;

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
