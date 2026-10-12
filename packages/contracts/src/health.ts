import { z } from 'zod';

/** GET /health — parity with app.py:617. */
export const HealthResponse = z.object({
  status: z.literal('ok'),
  service: z.literal('MASCLI'),
  version: z.string(),
});
export type HealthResponse = z.infer<typeof HealthResponse>;
