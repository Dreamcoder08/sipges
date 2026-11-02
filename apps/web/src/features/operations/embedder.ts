import { queryOptions } from '@tanstack/react-query';
import { z } from 'zod';
import { requestJson } from '../../shared/api/client.ts';

// Features are isolated (scripts/check-boundaries.mjs), so Inteligencia reads only the fields
// it shows; the search feature keeps its own reader of the same endpoint.
const EmbedderAvailability = z.object({
  available: z.boolean(),
  reason: z.enum(['unreachable', 'external_ai_disabled']).nullable(),
});

/** `GET /system/intelligence/embedder`: whether the semantic layer can run. */
export const embedderAvailabilityQuery = (scope: string) =>
  queryOptions({
    queryKey: ['intelligence', scope, 'embedder', 'availability'],
    queryFn: ({ signal }) =>
      requestJson('/system/intelligence/embedder', EmbedderAvailability, { scope, signal }),
    staleTime: 60_000,
    retry: false,
  });

export const unavailableReason = (reason: z.infer<typeof EmbedderAvailability>['reason']) =>
  reason === 'external_ai_disabled'
    ? 'el envío a IA externa está desactivado para este proyecto'
    : 'no se pudo contactar el modelo de embeddings';
