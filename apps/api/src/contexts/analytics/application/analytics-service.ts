import type { Scope } from '../../tenancy/application/index.ts';
import { automatedConsensus } from '../domain/consensus.ts';
import { DASHBOARD_MODULES, dashboardSummary } from '../domain/dashboard.ts';
import { integratedAnalysis } from '../domain/integrated.ts';
import { EXTENDED_MODULES, SITUATIONAL_MODULES, extendedRecords } from '../domain/records.ts';
import {
  REPORT_FILENAMES,
  consensusReport,
  integratedReport,
  situationalReport,
  strategicReport,
} from '../domain/reports.ts';
import { buildSituational } from '../domain/situational.ts';
import { strategicAssessment } from '../domain/strategic.ts';
import type { AnalyticsRecordReader, Clock, ReportRenderer } from './ports.ts';

const EXTENDED = Object.values(EXTENDED_MODULES);
const SITUATIONAL = [...SITUATIONAL_MODULES, 'Proyectos'];

/** Strategic analytics use cases: each reads the scope's records, then runs a pure engine. */
export type AnalyticsReport = keyof typeof REPORT_FILENAMES;

export type RenderedReport = {
  readonly fileName: string;
  readonly contentType: string;
  readonly bytes: Uint8Array;
};

export const createAnalyticsService = (deps: {
  reader: AnalyticsRecordReader;
  /** Optional narrow input for dashboard only; other engines always use reader. */
  dashboardReader?: AnalyticsRecordReader;
  clock: Clock;
  renderer: ReportRenderer;
}) => {
  const { reader, clock, renderer } = deps;
  // app.py now() has second precision; UTC is made explicit as in the tenancy export.
  const generatedAt = () => `${clock.now().toISOString().slice(0, 19)}Z`;
  const extended = async (scope: Scope) => extendedRecords(await reader.read(scope, EXTENDED));

  const situational = async (scope: Scope) =>
    buildSituational(await reader.read(scope, SITUATIONAL), scope.projectId, generatedAt());

  const outline = async (kind: AnalyticsReport, scope: Scope) => {
    switch (kind) {
      case 'situational':
        return situationalReport(await situational(scope));
      case 'integrated':
        return integratedReport(
          integratedAnalysis(await extended(scope), scope.projectId, generatedAt()),
        );
      case 'consensus':
        return consensusReport(
          automatedConsensus(await extended(scope), scope.projectId, generatedAt()),
        );
      case 'strategic': {
        const records = await extended(scope);
        return strategicReport(
          records,
          strategicAssessment(records, scope.projectId, generatedAt()),
          await situational(scope),
        );
      }
    }
  };

  return {
    /** Executive counters for the dashboard (app.py `/api/dashboard`). */
    async dashboard(scope: Scope) {
      return dashboardSummary(
        await (deps.dashboardReader ?? reader).read(scope, DASHBOARD_MODULES),
      );
    },
    situational,
    async strategic(scope: Scope) {
      return strategicAssessment(await extended(scope), scope.projectId, generatedAt());
    },
    async consensus(scope: Scope) {
      return automatedConsensus(await extended(scope), scope.projectId, generatedAt());
    },
    async integrated(scope: Scope) {
      return integratedAnalysis(await extended(scope), scope.projectId, generatedAt());
    },
    /** DOCX draft of one analysis (app.py *.docx routes); always for the active scope. */
    async report(kind: AnalyticsReport, scope: Scope): Promise<RenderedReport> {
      return {
        fileName: REPORT_FILENAMES[kind],
        contentType: renderer.contentType,
        bytes: await renderer.render(await outline(kind, scope)),
      };
    },
  };
};

export type AnalyticsService = ReturnType<typeof createAnalyticsService>;
