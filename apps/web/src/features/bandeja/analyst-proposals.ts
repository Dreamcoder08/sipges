import { queryOptions } from '@tanstack/react-query';
import { z } from 'zod';
import { requestJson } from '../../shared/api/client.ts';

// Proposals the Inicio analyst made (odd/archive/agentic-analyst.md S4). Their text comes from a
// model: it is rendered as plain text, never as HTML, and the server bounds every field.

const End = z.object({ module: z.string(), id: z.string() });

export const AnalystProposal = z.object({
  id: z.string(),
  kind: z.enum(['link', 'record']),
  title: z.string(),
  reason: z.string(),
  link: z.object({ link_type: z.string(), source: End, target: End }).nullable(),
  record: z.object({ module: z.string(), payload: z.record(z.string(), z.string()) }).nullable(),
  proposed_by: z.string(),
  proposed_at: z.string(),
});
export type AnalystProposal = z.infer<typeof AnalystProposal>;

const AnalystProposals = z.array(AnalystProposal);
const Decided = z.object({ ok: z.literal(true), result: z.string().nullable() });

const path = '/system/analyst/proposals';

export const analystProposalsQuery = (scope: string) =>
  queryOptions({
    queryKey: ['operations', scope, 'analyst-proposals'],
    queryFn: ({ signal }) => requestJson(path, AnalystProposals, { scope, signal }),
  });

/** The server writes through the owning context and audits; it answers 403 to a role that may not. */
export const decideAnalystProposal = (scope: string, id: string, approve: boolean) =>
  requestJson(path, Decided, {
    scope,
    method: 'POST',
    body: { json: { id, decision: approve ? 'approve' : 'reject' } },
  });
