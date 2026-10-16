import { expect, it } from 'vitest';
import { createManagementService } from './management-service.ts';

it('uses the Lima business day before UTC midnight to avoid premature overdue actions', async () => {
  const service = createManagementService({
    clock: { now: () => new Date('2026-10-16T02:00:00Z') },
    sources: {
      alerts: async () => [],
      commitmentRecords: async () => [],
      actions: async () => [
        {
          id: 'ACTION-TEST',
          alertId: 'AL-TEST',
          title: 'Acción de prueba',
          responsible: 'Responsable',
          dueDate: '2026-10-15',
          status: 'Pendiente',
          progress: 0,
          updatedAt: '',
        },
      ],
    },
  });
  const report = await service.overview({ companyId: 'TEST', projectId: 'PRJ-TEST' });
  expect(report.metrics.overdue_actions).toBe(0);
  expect(report.generated_at).toBe('2026-10-16T02:00:00Z');
});
