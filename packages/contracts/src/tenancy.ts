import { z } from 'zod';

/** PostgreSQL text cannot hold NUL: reject it as a 422 before it reaches a query. */
const withoutNul = (value: Record<string, string>) =>
  Object.values(value).every((text) => !text.includes('\u0000'));
const NUL_MESSAGE = { message: 'Text must not contain NUL characters' };

/** POST /system/auth/scopes body (app.py ScopeCreate). */
export const ScopeCreate = z
  .object({
    company_id: z.string(),
    project_id: z.string(),
    label: z.string(),
    username: z.string(),
  })
  .refine(withoutNul, NUL_MESSAGE);
export type ScopeCreate = z.infer<typeof ScopeCreate>;

const GrantFields = z.object({
  username: z.string(),
  company_id: z.string(),
  project_id: z.string(),
});

/** POST /system/auth/grants body (app.py GrantIn). */
export const GrantCreate = GrantFields.refine(withoutNul, NUL_MESSAGE);
export type GrantCreate = z.infer<typeof GrantCreate>;

/** DELETE /system/auth/grants: bound lookup text and reject PostgreSQL-invalid NULs. */
export const GrantRevoke = GrantFields.refine((value) =>
  Object.values(value).every(
    (text) => text.length > 0 && text.length <= 120 && !text.includes('\u0000'),
  ),
);

export const ScopeSummary = z.object({
  company_id: z.string(),
  project_id: z.string(),
  label: z.string(),
});
export type ScopeSummary = z.infer<typeof ScopeSummary>;

export const CurrentScope = z.object({
  company_id: z.string(),
  project_id: z.string(),
  scope: z.string(),
});
export type CurrentScope = z.infer<typeof CurrentScope>;

export const SelectProjectForm = z.object({ scope: z.string() });

/** 403 body when no authorized scope is selected (app.py enforce_auth step 4). */
export const ScopeRequired = z.object({ detail: z.string(), projects: z.array(z.string()) });
