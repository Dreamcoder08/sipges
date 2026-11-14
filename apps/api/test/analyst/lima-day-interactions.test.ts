import { describe, expect, it } from 'vitest';
import {
  type Subject,
  createAnalystService,
} from '../../src/contexts/analyst/application/index.ts';
import { createManagementService } from '../../src/contexts/management/application/index.ts';
import {
  type PreventiveAction,
  createPreventionService,
} from '../../src/contexts/prevention/application/index.ts';
import type { EgressGuard } from '../../src/contexts/privacy/application/index.ts';

// Services that read "today" must agree on the Lima calendar day (UTC−5) at the edges of the
// evening: 19:00 (UTC midnight), 23:59:59 and 00:00 of the next day. Synthetic data only.

const scope = { companyId: 'SIPGES', projectId: 'PRJ-SINTETICO' };
const tenant = 'SIPGES/PRJ-SINTETICO';
const DUE = '2026-11-13';

const plan: PreventiveAction = {
  id: 'PREV-SINTETICO',
  projectId: scope.projectId,
  alertId: 'ALR-SINTETICA',
  title: 'Mesa técnica sintética',
  responsible: 'Equipo social',
  dueDate: DUE,
  description: '',
  status: 'Pendiente',
  progress: 0,
  createdAt: new Date('2026-11-01T15:00:00Z'),
  updatedAt: new Date('2026-11-01T15:00:00Z'),
  history: [],
  block: null,
};

const preventionAt = (instant: string) =>
  createPreventionService({
    store: {
      list: async () => [plan],
      create: async () => {
        throw new Error('not used');
      },
      get: async () => null,
      update: async () => null,
    },
    alerts: { status: async () => null },
    evidence: { find: async () => null },
    clock: { now: () => new Date(instant) },
    randomHex: (length) => '0'.repeat(length),
  });

const managementAt = (instant: string) =>
  createManagementService({
    clock: { now: () => new Date(instant) },
    sources: {
      alerts: async () => [],
      commitmentRecords: async () => [],
      actions: async () => [
        {
          id: plan.id,
          alertId: plan.alertId,
          title: plan.title,
          responsible: plan.responsible,
          dueDate: plan.dueDate,
          status: plan.status,
          progress: plan.progress,
          updatedAt: '',
        },
      ],
    },
  });

const subject = (slug: string, fields: Record<string, string>): Subject => ({
  slug,
  id: 'SIN-1',
  typeLabel: slug === 'demandas' ? 'Demanda' : 'Compromiso',
  title: 'Registro sintético',
  date: null,
  marking: 'interno',
  fields,
});

const analystAt = (instant: string, found: Subject) =>
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

describe('prevention and management agree on overdue at the Lima day edges', () => {
  it.each([
    ['2026-11-13T19:00:00-05:00', 0],
    ['2026-11-13T23:59:59-05:00', 0],
    ['2026-11-14T00:00:00-05:00', 1],
  ])('at %s a plan due %s counts %i overdue in both', async (instant, overdue) => {
    const prevention = preventionAt(instant);
    const management = await managementAt(instant).overview(scope);
    expect((await prevention.summary(scope)).overdue).toBe(overdue);
    expect((await prevention.situationRoom(scope)).overdue).toHaveLength(overdue);
    expect(management.metrics.overdue_actions).toBe(overdue);
  });
});

describe('a proposed commitment deadline turns overdue at Lima midnight', () => {
  it('Plazo is today + 15; not overdue at 23:59:59 that day, overdue at 00:00 the next', async () => {
    const demand = subject('demandas', { Prioridad: 'Alta', Estado: 'Abierta' });
    const open = await analystAt('2026-11-13T23:30:00-05:00', demand).proposals(
      tenant,
      'demandas',
      'SIN-1',
    );
    const payload = open?.[0]?.record?.payload ?? {};
    expect(open?.[0]?.record?.slug).toBe('compromisos');
    expect(payload['Plazo']).toBe('2026-11-28');

    const commitment = subject('compromisos', {
      Plazo: String(payload['Plazo']),
      Estado: String(payload['Estado']),
    });
    const signals = async (instant: string) =>
      JSON.stringify(
        (await analystAt(instant, commitment).briefing(tenant, 'compromisos', 'SIN-1'))?.sections,
      );
    expect(await signals('2026-11-28T23:59:59-05:00')).not.toContain('venció');
    expect(await signals('2026-11-29T00:00:00-05:00')).toContain(
      'venció el 2026-11-28 sin cerrarse',
    );
  });
});
