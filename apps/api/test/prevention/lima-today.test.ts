import { describe, expect, it } from 'vitest';
import {
  type PreventiveAction,
  createPreventionService,
} from '../../src/contexts/prevention/application/index.ts';

// "Today" for the overdue rule is the calendar day in Peru (UTC−5), not the UTC date: after
// 19:00 in Lima the UTC date is already tomorrow. Synthetic plans only.

const scope = { companyId: 'SIPGES', projectId: 'PRJ-SINTETICO' };

const plan = (dueDate: string): PreventiveAction => ({
  id: 'PREV-SINTETICO',
  projectId: scope.projectId,
  alertId: 'ALR-SINTETICA',
  title: 'Mesa técnica sintética',
  responsible: 'Equipo social',
  dueDate,
  description: '',
  status: 'Pendiente',
  progress: 0,
  createdAt: new Date('2026-11-01T15:00:00Z'),
  updatedAt: new Date('2026-11-01T15:00:00Z'),
  history: [],
  block: null,
});

const serviceAt = (instant: string, actions: PreventiveAction[] = []) =>
  createPreventionService({
    store: {
      list: async () => actions,
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

describe('prevention "today" is the Lima calendar day', () => {
  it.each([
    ['2026-11-13T23:30:00-05:00', '2026-11-13'],
    ['2026-11-30T23:30:00-05:00', '2026-11-30'],
    ['2026-12-31T23:30:00-05:00', '2026-12-31'],
  ])('at %s today is %s', (instant, day) => {
    expect(serviceAt(instant).today()).toBe(day);
  });

  it('a plan due today in Lima is not overdue at 23:30 Lima', async () => {
    const service = serviceAt('2026-11-13T23:30:00-05:00', [plan('2026-11-13')]);
    expect((await service.summary(scope)).overdue).toBe(0);
    const room = await service.situationRoom(scope);
    expect(room.overdue).toEqual([]);
    expect(room.moving).toBe(1);
  });

  it('a plan due yesterday in Lima is overdue', async () => {
    const service = serviceAt('2026-11-13T23:30:00-05:00', [plan('2026-11-12')]);
    expect((await service.summary(scope)).overdue).toBe(1);
    expect((await service.situationRoom(scope)).overdue).toHaveLength(1);
  });
});
