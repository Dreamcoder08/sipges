import { AlertReviewed, TerritorialAlerts, TerritorialSummary } from '@sipges/contracts';
import { queryOptions } from '@tanstack/react-query';
import { requestJson } from './client.ts';

/** Digital territorial alerts of the project, shared by Inteligencia de redes and the inbox. */
export const territorialAlertsQuery = (scope: string) =>
  queryOptions({
    queryKey: ['operations', scope, 'alerts'],
    queryFn: ({ signal }) =>
      requestJson('/system/intelligence/territorial-alerts?limit=200', TerritorialAlerts, {
        scope,
        signal,
      }),
  });

export const territorialSummaryQuery = (scope: string) =>
  queryOptions({
    queryKey: ['operations', scope, 'summary'],
    queryFn: ({ signal }) =>
      requestJson('/system/intelligence/territorial-summary', TerritorialSummary, {
        scope,
        signal,
      }),
  });

/** The server decides who may move an alert (four eyes, docs/adr/0024); it answers 409 otherwise. */
export const reviewTerritorialAlert = (
  scope: string,
  id: string,
  review: { status: string; reviewer_note: string },
) =>
  requestJson(`/system/intelligence/territorial-alerts/${encodeURIComponent(id)}`, AlertReviewed, {
    scope,
    method: 'PATCH',
    body: { json: review },
  });
