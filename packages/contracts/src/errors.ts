import { z } from 'zod';

/** Error body kept compatible with FastAPI (docs/adr/0007-http-contract-and-errors.md). */
export const ErrorResponse = z.object({
  detail: z.unknown(),
});
export type ErrorResponse = z.infer<typeof ErrorResponse>;
