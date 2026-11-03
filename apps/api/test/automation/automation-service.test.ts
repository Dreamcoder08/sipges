import { describe, expect, it, vi } from 'vitest';
import { createAutomationService } from '../../src/contexts/automation/application/automation-service.ts';
import type {
  AutomationStore,
  ClaimedRun,
} from '../../src/contexts/automation/application/ports.ts';
const setup = (executionBudgetMs?: number) => {
  const store = {
    scan: vi.fn(async (_tenantId: string) => ({ scanned: 0, queued: 0 })),
    claimDue: vi.fn(async (): Promise<ClaimedRun[]> => []),
    finishRun: vi.fn(async () => {}),
  };
  const evaluate = vi.fn(async () => ({ outcome: 'created' as const, alertId: 'signal' }));
  const service = createAutomationService({
    ...(executionBudgetMs === undefined ? {} : { executionBudgetMs }),
    store: store as unknown as AutomationStore,
    sender: { send: async () => {} },
    sealer: { seal: (s) => s, open: (s) => s },
    clock: { now: () => new Date('2026-10-17T00:00:00Z') },
    recordModules: [],
    evaluateNarrative: evaluate,
  });
  return { store, service, evaluate };
};
const run = (marking = 'interno'): ClaimedRun => ({
  id: 1,
  ruleId: 1,
  ruleName: 'evaluate',
  attempts: 1,
  step: { kind: 'evaluate', title: 'Evaluar', minimumLevel: 'Media' },
  event: {
    auditId: 1,
    at: new Date('2026-10-17T00:00:00Z'),
    module: 'Narrativas',
    recordId: 'N1',
    action: 'CREATE',
    detail: '',
    record: { payload: { Descripcion: 'test', URL_Publicacion: 'https://example.org' }, marking },
  },
});
describe('bounded tenant execution', () => {
  it('does not make a tick wait on a tick of the same tenant that never finishes', async () => {
    // On Workers a tick started by a cancelled request never settles for another request;
    // concurrent ticks are safe because the scan locks the tenant's cursor in the database.
    const { service, store } = setup();
    store.scan.mockImplementationOnce(() => new Promise(() => {}));
    void service.tick('A');
    const again = await Promise.race([
      service.tick('A'),
      new Promise<'hung'>((resolve) => setTimeout(() => resolve('hung'), 500)),
    ]);
    expect(again).not.toBe('hung');
    await service.tick('B');
    expect(store.scan.mock.calls.map((c) => c[0])).toEqual(['A', 'A', 'B']);
  });
  it('evaluates and scans a follow-up round', async () => {
    const { service, store, evaluate } = setup();
    store.claimDue.mockResolvedValueOnce([run()]);
    await service.tick('A');
    expect(evaluate).toHaveBeenCalledWith('A', run().event, 'Media');
    expect(store.scan).toHaveBeenCalledTimes(2);
    expect(store.finishRun).toHaveBeenCalledWith('A', 1, { status: 'done' }, expect.any(Date));
  });
  it('caps rounds and honors an exhausted wall time budget', async () => {
    const active = setup();
    active.store.scan.mockResolvedValue({ scanned: 1, queued: 0 });
    await active.service.tick('A');
    expect(active.store.scan).toHaveBeenCalledTimes(3);
    const exhausted = setup(0);
    await exhausted.service.tick('B');
    expect(exhausted.store.scan).not.toHaveBeenCalled();
    expect(exhausted.store.claimDue).not.toHaveBeenCalled();
  });
  it('never evaluates restricted narratives', async () => {
    const { service, store, evaluate } = setup();
    store.claimDue.mockResolvedValueOnce([run('restringido')]);
    await service.tick('A');
    expect(evaluate).not.toHaveBeenCalled();
  });
});
