import type { Briefing } from '@mascli/contracts';
import { Hono } from 'hono';
import type { AppEnv } from '../../../platform/http/env.ts';
import { isoSeconds } from '../../../platform/http/time.ts';
import { formatScope } from '../../tenancy/application/index.ts';
import type { AnalystService, Subject } from '../application/index.ts';

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
  new Hono<AppEnv>().get('/system/briefing', async (c) => {
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
