import {
  IndicatorsReport,
  IrsaConfig,
  IrsaHistory,
  IrsaReport,
  ModelStatus,
  ValidationTemplate,
} from '@sipges/contracts';
import { queryOptions } from '@tanstack/react-query';
import { requestJson } from '../../shared/api/client.ts';
export const irsaQuery = (scope: string) =>
  queryOptions({
    queryKey: ['indicators', scope, 'irsa'],
    queryFn: ({ signal }) => requestJson('/system/irsa', IrsaReport, { scope, signal }),
  });
export const configQuery = (scope: string) =>
  queryOptions({
    queryKey: ['indicators', scope, 'config'],
    queryFn: ({ signal }) => requestJson('/system/irsa/config', IrsaConfig, { scope, signal }),
  });
export const historyQuery = (scope: string) =>
  queryOptions({
    queryKey: ['indicators', scope, 'history'],
    queryFn: ({ signal }) =>
      requestJson('/system/irsa/history?limit=50', IrsaHistory, { scope, signal }),
  });
export const indicatorsQuery = (scope: string) =>
  queryOptions({
    queryKey: ['indicators', scope, 'report'],
    queryFn: ({ signal }) => requestJson('/system/indicators', IndicatorsReport, { scope, signal }),
  });
export const modelQuery = (scope: string) =>
  queryOptions({
    queryKey: ['indicators', scope, 'model'],
    queryFn: ({ signal }) => requestJson('/system/model-status', ModelStatus, { scope, signal }),
  });
export const templateQuery = (scope: string) =>
  queryOptions({
    queryKey: ['indicators', scope, 'template'],
    queryFn: ({ signal }) =>
      requestJson('/system/validation-template', ValidationTemplate, { scope, signal }),
  });
