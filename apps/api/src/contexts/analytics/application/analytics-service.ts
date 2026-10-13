import type { Scope } from '../../tenancy/application/index.ts';
import { automatedConsensus } from '../domain/consensus.ts';
import { integratedAnalysis } from '../domain/integrated.ts';
import { EXTENDED_MODULES, SITUATIONAL_MODULES, extendedRecords } from '../domain/records.ts';
import { buildSituational } from '../domain/situational.ts';
import { strategicAssessment } from '../domain/strategic.ts';
import type { AnalyticsRecordReader, Clock } from './ports.ts';

const EXTENDED = Object.values(EXTENDED_MODULES);
const SITUATIONAL = [...SITUATIONAL_MODULES, 'Proyectos'];

/** Strategic analytics use cases: each reads the scope's records, then runs a pure engine. */
export const createAnalyticsService = (deps: { reader: AnalyticsRecordReader; clock: Clock }) => {
  const { reader, clock } = deps;
  // app.py now() has second precision; UTC is made explicit as in the tenancy export.
  const generatedAt = () => `${clock.now().toISOString().slice(0, 19)}Z`;
  const extended = async (scope: Scope) =>
    extendedRecords(await reader.read(scope, EXTENDED), scope.projectId);

  return {
    async situational(scope: Scope) {
      return buildSituational(
        await reader.read(scope, SITUATIONAL),
        scope.projectId,
        generatedAt(),
      );
    },
    async strategic(scope: Scope) {
      return strategicAssessment(await extended(scope), scope.projectId, generatedAt());
    },
    async consensus(scope: Scope) {
      return automatedConsensus(await extended(scope), scope.projectId, generatedAt());
    },
    async integrated(scope: Scope) {
      return integratedAnalysis(await extended(scope), scope.projectId, generatedAt());
    },
  };
};

export type AnalyticsService = ReturnType<typeof createAnalyticsService>;
