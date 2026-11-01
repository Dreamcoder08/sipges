import {
  type ImportIn,
  ImportReport,
  ModuleRecord,
  OkResponse,
  RecordCreated,
  RecordIn,
  RecordVersion,
} from '@sipges/contracts';
import { queryOptions } from '@tanstack/react-query';
import { z } from 'zod';
import { isApiError, requestJson } from '../../shared/api/client.ts';
import { fetchModuleRecords } from '../../shared/api/module-records.ts';
import { recordPayload } from './model.ts';
import type { RecordModule } from './modules.ts';

const recordPath = (module: RecordModule, id?: string) =>
  `/api/${module}${id === undefined ? '' : `/${encodeURIComponent(id)}`}`;
export const recordsQuery = (module: RecordModule, scope: string, search: string) =>
  queryOptions({
    queryKey: ['records', scope, module, 'list', search],
    queryFn: ({ signal }) => fetchModuleRecords(module, scope, search, signal),
  });
export const recordQuery = (module: RecordModule, scope: string, id: string) =>
  queryOptions({
    queryKey: ['records', scope, module, 'detail', id],
    queryFn: ({ signal }) => requestJson(recordPath(module, id), ModuleRecord, { scope, signal }),
  });
export const historyQuery = (module: RecordModule, scope: string, id: string) =>
  queryOptions({
    queryKey: ['records', scope, module, 'history', id],
    queryFn: ({ signal }) =>
      requestJson(`${recordPath(module, id)}/history`, z.array(RecordVersion), { scope, signal }),
  });
export const saveRecord = async (
  module: RecordModule,
  scope: string,
  projectId: string,
  projectLabel: string,
  values: Record<string, string>,
  id?: string,
  extras: Record<string, string> = {},
) => {
  const latest =
    id === undefined
      ? undefined
      : await requestJson(recordPath(module, id), ModuleRecord, { scope });
  const body = RecordIn.parse({
    payload: recordPayload(module, values, projectId, projectLabel, latest, extras),
  });
  if (id !== undefined) {
    await requestJson(recordPath(module, id), OkResponse, {
      method: 'PUT',
      scope,
      body: { json: body },
    });
    return id;
  }
  return (
    await requestJson(recordPath(module), RecordCreated, {
      method: 'POST',
      scope,
      body: { json: body },
    })
  ).id;
};
export const deleteRecord = (module: RecordModule, scope: string, id: string) =>
  requestJson(recordPath(module, id), OkResponse, { method: 'DELETE', scope });
export const importRecords = (module: RecordModule, scope: string, body: ImportIn) =>
  requestJson(`/system/import/${module}`, ImportReport, {
    method: 'POST',
    scope,
    body: { json: body },
  }).catch((error: unknown) => {
    // A refused batch answers 422 with the same report shape.
    const parsed = isApiError(error, 422) ? ImportReport.safeParse(error.body) : null;
    if (parsed?.success) return parsed.data;
    throw error;
  });
