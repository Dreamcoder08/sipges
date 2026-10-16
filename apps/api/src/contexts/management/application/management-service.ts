import { limaToday } from '@mascli/kernel';
import type { Scope } from '../../tenancy/application/index.ts';
import { commitmentsOf, managementCsv, managementOverview } from '../domain/index.ts';
import type { Clock, ManagementSources } from './ports.ts';

export const createManagementService = (deps: { sources: ManagementSources; clock: Clock }) => {
  const { sources, clock } = deps;

  const overview = async (scope: Scope) => {
    const now = clock.now();
    const [alerts, actions, records] = await Promise.all([
      sources.alerts(scope),
      sources.actions(scope),
      sources.commitmentRecords(scope),
    ]);
    return managementOverview({
      projectId: scope.projectId,
      generatedAt: `${now.toISOString().slice(0, 19)}Z`,
      today: limaToday(now),
      alerts,
      actions,
      commitments: commitmentsOf(records, scope.projectId),
    });
  };

  return {
    overview,
    async csv(scope: Scope) {
      return managementCsv(await overview(scope));
    },
  };
};

export type ManagementService = ReturnType<typeof createManagementService>;
