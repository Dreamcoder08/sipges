import { expect, it } from 'vitest';
import { commitmentsOf, managementOverview, type ActionRow } from './overview.ts';

it('counts only real, overdue dates on ongoing actions and normalizes terminal states', () => {
  const action = (id: string, dueDate: string, status = 'Pendiente'): ActionRow => ({
    id,
    dueDate,
    status,
    alertId: '',
    title: id,
    responsible: 'Equipo',
    progress: 0,
    updatedAt: '',
  });
  const report = managementOverview({
    projectId: 'P-1',
    generatedAt: '',
    today: '2026-10-15',
    alerts: [],
    commitments: [],
    actions: [
      action('blank', ''),
      action('invalid', '2026-02-30'),
      action('today', '2026-10-15'),
      action('late', '2026-10-14'),
      action('done', '2026-10-14', ' CUMPLIDA '),
      action('cancel', '2026-10-14', 'Cancelado'),
      action('failed', '2026-10-14', 'Incumplido'),
    ],
  });
  expect(report.metrics.overdue_actions).toBe(2);
  expect(report.metrics.active_actions).toBe(5);
  expect(report.metrics.completed_actions).toBe(1);
  expect(report.critical_actions.map((row) => row.id)).toEqual(['late', 'failed']);
});

it('uses valid ISO Plazo commitments and keeps free text out of due dates', () => {
  const records = [
    { id: 'iso', payload: { Proyecto_ID: 'P-1', Plazo: '2026-10-15' } },
    { id: 'text', payload: { Proyecto_ID: 'P-1', Plazo: 'Próxima reunión' } },
    {
      id: 'invalid',
      payload: { Proyecto_ID: 'P-1', Fecha_Vencimiento: '2026-02-30', Plazo: '2026-10-15' },
    },
  ];
  expect(commitmentsOf(records).map((row) => row.due_date)).toEqual(['2026-10-15', '', '']);
});
