import { z } from 'zod';

/** API keys for machines: MCP clients and inbound hooks (docs/adr/0014 §6). */
export const ApiKeyIn = z.object({
  name: z
    .string()
    .trim()
    .min(1)
    .max(80)
    .refine((v) => !v.includes('\u0000'), { message: 'Text must not contain NUL characters' }),
  access: z.enum(['read', 'write']).default('read'),
  clearance: z.enum(['limited', 'full']).default('limited'),
});
export type ApiKeyIn = z.infer<typeof ApiKeyIn>;

export const ApiKeyOut = z.object({
  id: z.number().int(),
  name: z.string(),
  prefix: z.string(),
  access: z.enum(['read', 'write']),
  clearance: z.enum(['limited', 'full']),
  created_by: z.string(),
  created_at: z.string(),
  last_used_at: z.string().nullable(),
  revoked_at: z.string().nullable(),
});
export type ApiKeyOut = z.infer<typeof ApiKeyOut>;

/** The token appears only in this answer. */
export const ApiKeyCreated = z.object({
  ok: z.literal(true),
  id: z.number().int(),
  token: z.string(),
});
export type ApiKeyCreated = z.infer<typeof ApiKeyCreated>;
