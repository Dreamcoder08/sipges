import { ValidationTemplate } from '@sipges/contracts';
import { queryOptions } from '@tanstack/react-query';
import { requestJson } from './client.ts';

/** Expert-review template of the indicator model, shared by Validación and the inbox. */
export const templateQuery = (scope: string) =>
  queryOptions({
    queryKey: ['indicators', scope, 'template'],
    queryFn: ({ signal }) =>
      requestJson('/system/validation-template', ValidationTemplate, { scope, signal }),
  });
