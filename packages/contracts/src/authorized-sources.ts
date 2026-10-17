import { z } from 'zod';
const text = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .refine((value) => !value.includes('\0'));
export const AuthorizedSourceConfigIn = z.object({
  enabled: z.boolean(),
  query: text(100).default(''),
  territory: text(200).default(''),
  authorization_note: text(1000).default(''),
});
export type AuthorizedSourceConfigIn = z.infer<typeof AuthorizedSourceConfigIn>;
export const AuthorizedSourceImportIn = z.object({
  post_id: z.number().int().positive().max(2147483647),
  territory: text(200).optional(),
});
export type AuthorizedSourceImportIn = z.infer<typeof AuthorizedSourceImportIn>;
export const OfficialSourcePost = z.object({
  id: z.number().int().positive(),
  url: z.string().url(),
  title: z.string(),
  excerpt: z.string(),
  published_at: z.string(),
});
export type OfficialSourcePost = z.infer<typeof OfficialSourcePost>;
export const AuthorizedSourceState = AuthorizedSourceConfigIn.extend({
  revision: z.number().int(),
  updated_by: z.string(),
  updated_at: z.string().nullable(),
  last_poll_at: z.string().nullable(),
  last_poll_error: z.string(),
  last_imported: z.number(),
  last_duplicates: z.number(),
});
export type AuthorizedSourceState = z.infer<typeof AuthorizedSourceState>;
export const AuthorizedSourcesCatalog = z.object({
  id: z.literal('defensoria'),
  name: z.string(),
  url: z.string(),
  checked_at: z.string(),
  attribution: z.string(),
  state: AuthorizedSourceState,
});
