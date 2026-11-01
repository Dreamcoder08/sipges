import { type ModuleRecord, SituationsReport } from '@sipges/contracts';
import { queryOptions } from '@tanstack/react-query';
import { requestJson } from './client.ts';
import { fetchModuleRecords } from './module-records.ts';

/** Alerts created from a situation carry this origin; the engine never counts them again. */
export const GENERATED_ORIGIN = 'SIPGES';

export const situationsReportQuery = (scope: string) =>
  queryOptions({
    queryKey: ['situations', scope],
    queryFn: ({ signal }) =>
      requestJson('/system/v4/situations', SituationsReport, { scope, signal }),
  });

/** Alerts already created from a situation, so the same one is not raised twice. */
export const situationAlertsQuery = (scope: string) =>
  queryOptions({
    queryKey: ['situations', scope, 'alerts'],
    queryFn: ({ signal }) => fetchModuleRecords('alertas', scope, '', signal),
  });

/** Situation key → id of the alert already raised from it. */
export const raisedSituations = (alerts: readonly ModuleRecord[]) =>
  new Map(
    alerts
      .filter((row) => row.Origen === GENERATED_ORIGIN && typeof row.Situacion === 'string')
      .map((row) => [String(row.Situacion), row._id]),
  );
