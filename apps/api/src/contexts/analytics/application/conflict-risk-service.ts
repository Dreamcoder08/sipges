import { limaToday } from '@sipges/kernel';
import type { Scope } from '../../tenancy/application/index.ts';
import { RISK_MODULES, conflictRisk } from '../domain/conflict-risk/index.ts';
import type { Clock, ConflictRiskSources } from './ports.ts';

/** Conflict-risk prediction use case (docs/adr/0031): reads the scope's sources, then runs the pure engine. */
export const createConflictRiskService = (deps: {
  sources: ConflictRiskSources;
  clock: Clock;
}) => ({
  async predict(scope: Scope) {
    const [records, alerts, irsa] = await Promise.all([
      deps.sources.records(scope, RISK_MODULES),
      deps.sources.alerts(scope),
      deps.sources.irsa(scope),
    ]);
    return conflictRisk({
      records,
      alerts,
      irsa,
      today: limaToday(deps.clock.now()),
      projectId: scope.projectId,
    });
  },
});

export type ConflictRiskService = ReturnType<typeof createConflictRiskService>;
