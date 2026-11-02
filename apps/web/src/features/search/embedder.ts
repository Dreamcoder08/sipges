import { queryOptions } from '@tanstack/react-query';
import { z } from 'zod';
import { requestJson } from '../../shared/api/client.ts';

/** `GET /system/intelligence/embedder`: whether semantic features can run (T11 functional-closure). */
export const EmbedderStatus = z.object({
  configured: z.boolean(),
  available: z.boolean(),
  reason: z.enum(['unreachable', 'external_ai_disabled']).nullable(),
  model: z.string(),
  egress: z.enum(['local', 'external']),
  semantic_search: z.boolean(),
});
export type EmbedderStatus = z.infer<typeof EmbedderStatus>;

export const embedderStatusQuery = (scope: string) =>
  queryOptions({
    queryKey: ['intelligence', scope, 'embedder'],
    queryFn: ({ signal }) =>
      requestJson('/system/intelligence/embedder', EmbedderStatus, { scope, signal }),
    // The API caches its probe for a minute; asking more often learns nothing new.
    staleTime: 60_000,
    retry: false,
  });

/** Why the semantic model cannot be used, in the words the screens show. */
export const embedderUnavailableReason = (status: EmbedderStatus) =>
  status.reason === 'external_ai_disabled'
    ? 'el envío a IA externa está desactivado para este proyecto'
    : 'no se pudo contactar el modelo de embeddings';

/** Semantic search is switched on but its model cannot be used: results are keyword only. */
export const semanticSearchDown = (status: EmbedderStatus) =>
  status.semantic_search && !status.available;
