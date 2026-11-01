import { type AnalystProposal, type Briefing, ProposalDecisionIn } from '@sipges/contracts';
import { Hono } from 'hono';
import type { AppEnv } from '../../../platform/http/env.ts';
import { isoSeconds } from '../../../platform/http/time.ts';
import { formatScope } from '../../tenancy/application/index.ts';
import { parseJson } from '../../../platform/http/validation.ts';
import type { AnalystService, Proposal, Subject } from '../application/index.ts';

const proposalOut = (p: Proposal): AnalystProposal => ({
  fingerprint: p.fingerprint,
  kind: p.kind,
  title: p.title,
  reason: p.reason,
  link: p.link
    ? {
        link_type: p.link.linkType,
        source: { module: p.link.source.slug, id: p.link.source.id },
        target: { module: p.link.target.slug, id: p.link.target.id },
      }
    : null,
  record: p.record ? { module: p.record.slug, payload: { ...p.record.payload } } : null,
});

const DECIDE_ERRORS = {
  missing: [404, 'La propuesta ya no está disponible'],
  decided: [409, 'Otra persona ya decidió esta propuesta'],
  failed: [422, 'No se pudo aplicar la propuesta'],
} as const;

const subjectOut = (subject: Subject): Briefing['subject'] => ({
  module: subject.slug,
  id: subject.id,
  type_label: subject.typeLabel,
  title: subject.title,
  date: subject.date,
  marking: subject.marking as Briefing['subject']['marking'],
  fields: { ...subject.fields },
});

/** Cited entity briefings (docs/adr/0013). */
export const analystRoutes = (analyst: AnalystService) =>
  new Hono<AppEnv>()
    .get('/system/briefing/proposals', async (c) => {
      const found = await analyst.proposals(
        formatScope(c.get('scope')),
        c.req.query('module') ?? '',
        c.req.query('id') ?? '',
      );
      if (!found) return c.json({ detail: 'Registro no encontrado' }, 404);
      return c.json(found.map(proposalOut));
    })
    .post('/system/briefing/proposals', async (c) => {
      const body = await parseJson(c, ProposalDecisionIn);
      if (!body.ok) return body.response;
      const decided = await analyst.decide(
        formatScope(c.get('scope')),
        {
          slug: body.value.module,
          id: body.value.id,
          fingerprint: body.value.fingerprint,
          approve: body.value.decision === 'approve',
        },
        c.get('identity').username,
      );
      if (!decided.ok) {
        const [status, detail] = DECIDE_ERRORS[decided.error];
        return c.json({ detail }, status);
      }
      return c.json({ ok: true as const, result: decided.value.result });
    })
    .get('/system/briefing', async (c) => {
      const result = await analyst.briefing(
        formatScope(c.get('scope')),
        c.req.query('module') ?? '',
        c.req.query('id') ?? '',
      );
      if (!result) return c.json({ detail: 'Registro no encontrado' }, 404);
      return c.json({
        subject: subjectOut(result.subject),
        generated_at: isoSeconds(result.generatedAt),
        engine: result.engine,
        narrator: result.engine === 'asistido' ? analyst.narratorName : null,
        notice: result.notice,
        narrative: result.narrative
          ? { text: result.narrative.text, refs: [...result.narrative.refs] }
          : null,
        sections: result.sections.map((section) => ({
          title: section.title,
          sentences: section.sentences.map((s) => ({ text: s.text, refs: [...s.refs] })),
        })),
        sources: result.sources.map((source) => ({
          ref: source.ref,
          module: source.slug,
          id: source.id,
          type_label: source.typeLabel,
          title: source.title,
        })),
      } satisfies Briefing);
    });
