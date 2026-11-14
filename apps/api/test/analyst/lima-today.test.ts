import { describe, expect, it } from 'vitest';
import {
  type Subject,
  createAnalystService,
} from '../../src/contexts/analyst/application/index.ts';
import type { EgressGuard } from '../../src/contexts/privacy/application/index.ts';

// The analyst's "today" (overdue commitments, follow-up deadlines) is the calendar day in Peru
// (UTC−5), not the UTC date. Synthetic records only.

const tenant = 'SIPGES/PRJ-SINTETICO';

const subject = (slug: string, fields: Record<string, string>): Subject => ({
  slug,
  id: 'SIN-1',
  typeLabel: slug === 'alertas' ? 'Alerta' : 'Compromiso',
  title: 'Registro sintético',
  date: null,
  marking: 'interno',
  fields,
});

const serviceAt = (instant: string, found: Subject) =>
  createAnalystService({
    source: {
      neighbours: async () => ({ subject: found, connections: [] }),
      mentions: async () => [],
    },
    narrator: null,
    egress: {} as EgressGuard,
    clock: { now: () => new Date(instant) },
    proposals: {
      store: { decided: async () => new Set(), save: async () => true },
      actions: { link: async () => 'created', create: async () => null },
    },
  });

const openAlert = subject('alertas', { Nivel_Preliminar: 'Alto', Estado: 'Abierta' });

describe('analyst "today" is the Lima calendar day', () => {
  it.each([
    ['2026-11-13T23:30:00-05:00', '2026-11-20'],
    ['2026-11-30T23:30:00-05:00', '2026-12-07'],
    ['2026-12-31T23:30:00-05:00', '2027-01-07'],
  ])('a follow-up proposed at %s is due %s (Lima today + 7)', async (instant, due) => {
    const open = await serviceAt(instant, openAlert).proposals(tenant, 'alertas', 'SIN-1');
    expect(open?.map((p) => p.record?.payload['Plazo'])).toEqual([due]);
  });

  const briefingText = async (instant: string, plazo: string) =>
    JSON.stringify(
      (
        await serviceAt(
          instant,
          subject('compromisos', { Plazo: plazo, Estado: 'Pendiente' }),
        ).briefing(tenant, 'compromisos', 'SIN-1')
      )?.sections,
    );

  it('a commitment due today in Lima is not reported overdue at 23:30 Lima', async () => {
    expect(await briefingText('2026-11-13T23:30:00-05:00', '2026-11-13')).not.toContain('venció');
  });

  it('a commitment due yesterday in Lima is reported overdue', async () => {
    expect(await briefingText('2026-11-13T23:30:00-05:00', '2026-11-12')).toContain(
      'venció el 2026-11-12 sin cerrarse',
    );
  });
});
