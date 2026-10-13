import { ModuleRecord, OkResponse, RecordCreated, RecordIn } from '@mascli/contracts';
import { queryOptions } from '@tanstack/react-query';
import { z } from 'zod';
import { requestJson } from '../../shared/api/client.ts';
import { recordPayload } from './model.ts';
import type { RecordModule } from './modules.ts';

const recordPath = (module: RecordModule, id?: string) =>
  `/api/${module}${id === undefined ? '' : `/${encodeURIComponent(id)}`}`;
export const recordsQuery = (module: RecordModule, scope: string, search: string) =>
  queryOptions({
    queryKey: ['records', scope, module, 'list', search],
    queryFn: ({ signal }) =>
      requestJson(
        `${recordPath(module)}?${new URLSearchParams({ limit: '-1', q: search })}`,
        z.array(ModuleRecord),
        { scope, signal },
      ),
  });
export const recordQuery = (module: RecordModule, scope: string, id: string) =>
  queryOptions({
    queryKey: ['records', scope, module, 'detail', id],
    queryFn: ({ signal }) => requestJson(recordPath(module, id), ModuleRecord, { scope, signal }),
  });
export const saveRecord = async (
  module: RecordModule,
  scope: string,
  projectId: string,
  projectLabel: string,
  values: Record<string, string>,
  id?: string,
) => {
  const latest =
    id === undefined
      ? undefined
      : await requestJson(recordPath(module, id), ModuleRecord, { scope });
  const body = RecordIn.parse({
    payload: recordPayload(module, values, projectId, projectLabel, latest),
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
