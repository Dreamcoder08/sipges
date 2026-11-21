import { z } from 'zod';

/**
 * The SIPGES release version, the root package.json "version" (odd/archive/functional-10.md T8).
 * /health and the model status report it, in TypeScript and Go alike (Go: internal/platform/
 * release); a test on each side pins it to package.json. The IRSA method version
 * (`config_version`, «Método IRSA v0.4») is separate.
 */
export const SIPGES_VERSION = '1.1.0';

/** GET /health — parity with app.py:617. */
export const HealthResponse = z.object({
  status: z.literal('ok'),
  service: z.literal('SIPGES'),
  version: z.string(),
});
export type HealthResponse = z.infer<typeof HealthResponse>;
