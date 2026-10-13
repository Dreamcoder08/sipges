import { z } from 'zod';

// The SPA runs under a CSP without 'unsafe-eval' (docs/migration/web.md). Zod 4 otherwise probes
// `new Function` on first parse; the probe is caught but still reported as a
// securitypolicyviolation. Jitless parsing gives the same results without code generation.
z.config({ jitless: true });
