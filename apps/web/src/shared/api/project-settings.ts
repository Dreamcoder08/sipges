import { ProjectSettings } from '@sipges/contracts';
import { queryOptions } from '@tanstack/react-query';
import { requestJson } from './client.ts';

/** Colour meanings, phase and thresholds of the active project (docs/adr/0020). */
export const projectSettingsQuery = (scope: string) =>
  queryOptions({
    queryKey: ['project-settings', scope],
    queryFn: ({ signal }) => requestJson('/system/v4/settings', ProjectSettings, { scope, signal }),
    staleTime: 60_000,
  });
