import { type Result, err, ok } from '@mascli/kernel';
import { log } from '../../../platform/observability/logger.ts';
import {
  type Briefing,
  type Sentence,
  briefingText,
  buildBriefing,
  citedRefs,
} from '../domain/briefing.ts';
import { type Proposal, followUpProposals, mentionProposal } from '../domain/proposals.ts';
import type { BriefingSource, Clock, Narrator, ProposalActions, ProposalStore } from './ports.ts';

export type DecideError = 'missing' | 'decided' | 'failed';

export const NARRATION_TIMEOUT_MS = 20_000;
const MAX_NARRATIVE_CHARS = 4_000;

export type BriefingResult = Briefing & {
  readonly generatedAt: Date;
  /** Prose from the narrator citing `sources`, or null when only the extractive text exists. */
  readonly narrative: Sentence | null;
  readonly engine: 'extractivo' | 'asistido';
  readonly notice: string | null;
};

const NARRATION_FAILED =
  'El resumen asistido no estuvo disponible; se muestra el informe extractivo.';
const NARRATION_WITHHELD =
  'El registro está restringido; el resumen asistido no se genera para información restringida.';

export const createAnalystService = (deps: {
  source: BriefingSource;
  narrator: Narrator | null;
  clock: Clock;
  proposals?: { store: ProposalStore; actions: ProposalActions };
}) => {
  /** Open proposals for one record: follow-ups first, then links read from text. */
  const proposalsFor = async (
    tenantId: string,
    slug: string,
    id: string,
  ): Promise<Proposal[] | null> => {
    if (!deps.proposals) return [];
    const [found, mentions] = await Promise.all([
      deps.source.neighbours(tenantId, slug, id),
      deps.source.mentions(tenantId, slug, id),
    ]);
    if (!found) return null;
    const today = deps.clock.now().toISOString().slice(0, 10);
    const all = [
      ...followUpProposals(found.subject, found.connections, today),
      ...(mentions ?? []).map((m) => mentionProposal(found.subject, m)),
    ];
    const decided = await deps.proposals.store.decided(
      tenantId,
      all.map((p) => p.fingerprint),
    );
    return all.filter((p) => !decided.has(p.fingerprint));
  };

  return {
    narratorName: deps.narrator?.name ?? null,

    proposals: proposalsFor,

    /**
     * Applies or discards one proposal. The proposal is recomputed from current data, so only
     * an action the analyst would offer right now can be approved.
     */
    async decide(
      tenantId: string,
      input: { slug: string; id: string; fingerprint: string; approve: boolean },
      actor: string,
    ): Promise<Result<{ result: string | null }, DecideError>> {
      const handler = deps.proposals;
      if (!handler) return err('missing');
      const open = await proposalsFor(tenantId, input.slug, input.id);
      const proposal = open?.find((p) => p.fingerprint === input.fingerprint);
      if (!proposal) return err('missing');
      let result: string | null = null;
      if (input.approve && proposal.link) {
        const linked = await handler.actions.link(
          tenantId,
          proposal.link,
          'Propuesta del analista aprobada',
          actor,
        );
        if (linked === 'failed') return err('failed');
      } else if (input.approve && proposal.record) {
        const created = await handler.actions.create(tenantId, proposal.record);
        if (!created) return err('failed');
        result = `${proposal.record.slug}/${created}`;
      }
      const saved = await handler.store.save(tenantId, {
        fingerprint: proposal.fingerprint,
        subject: { slug: input.slug, id: input.id },
        kind: proposal.kind,
        decision: input.approve ? 'approved' : 'rejected',
        result,
        title: proposal.title,
        actor,
        at: deps.clock.now(),
      });
      return saved ? ok({ result }) : err('decided');
    },

    async briefing(tenantId: string, slug: string, id: string): Promise<BriefingResult | null> {
      const found = await deps.source.neighbours(tenantId, slug, id);
      if (!found) return null;
      const now = deps.clock.now();
      const today = now.toISOString().slice(0, 10);
      const briefing = buildBriefing(found.subject, found.connections, today);
      const extractive = {
        ...briefing,
        generatedAt: now,
        narrative: null,
        engine: 'extractivo' as const,
      };
      const narrator = deps.narrator;
      if (!narrator) return { ...extractive, notice: null };
      if (found.subject.marking === 'restringido')
        return { ...extractive, notice: NARRATION_WITHHELD };

      // Restricted neighbours never leave the platform: the model sees a briefing without them.
      const shared = buildBriefing(
        found.subject,
        found.connections.filter((c) => c.other.marking !== 'restringido'),
        today,
      );
      try {
        const prose = (
          await narrator.narrate(briefingText(shared), AbortSignal.timeout(NARRATION_TIMEOUT_MS))
        )
          .trim()
          .slice(0, MAX_NARRATIVE_CHARS);
        const used = prose ? citedRefs(prose, shared) : null;
        if (!used?.length) throw new Error('Narrative cites no valid source');
        // Renumber the shared briefing's citations onto the full briefing's sources.
        const refOf = new Map(briefing.sources.map((s) => [`${s.slug}\u0000${s.id}`, s.ref]));
        const remap = new Map(
          shared.sources.map((s) => [s.ref, refOf.get(`${s.slug}\u0000${s.id}`) ?? 0]),
        );
        const text = prose.replace(
          /\[(\d{1,4})\]/g,
          (_, n: string) => `[${remap.get(Number(n)) ?? 0}]`,
        );
        return {
          ...extractive,
          narrative: { text, refs: used.map((ref) => remap.get(ref) ?? 0) },
          engine: 'asistido',
          notice: null,
        };
      } catch (error) {
        log('warn', 'briefing_narration_failed', { narrator: narrator.name, error });
        return { ...extractive, notice: NARRATION_FAILED };
      }
    },
  };
};

export type AnalystService = ReturnType<typeof createAnalystService>;
