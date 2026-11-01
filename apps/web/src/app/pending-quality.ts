import { useQueries } from '@tanstack/react-query';
import type { QualityReview } from '../features/bandeja/index.ts';
import { recordsQuery } from '../features/records/api.ts';
import {
  QUALITY_MODULES,
  qualityIssues,
  type QualityData,
} from '../features/records/quality/model.ts';

/**
 * The data-quality review for the Pendientes inbox. Features never import each other, so the
 * app composes it: the same record lists and the same rules as the Calidad de datos screen.
 * Like that screen, it reports nothing rather than a partial result when a list fails.
 */
export const useQualityReview = (scope: string): QualityReview => {
  const queries = useQueries({
    queries: QUALITY_MODULES.map((module) => recordsQuery(module, scope, '')),
  });
  if (queries.some((query) => query.isError))
    return {
      state: 'error',
      retry: () =>
        void Promise.all(queries.filter((query) => query.isError).map((query) => query.refetch())),
    };
  if (queries.some((query) => query.isPending)) return { state: 'loading' };
  const data: QualityData = {
    actores: queries[0]?.data ?? [],
    alertas: queries[1]?.data ?? [],
    eventos: queries[2]?.data ?? [],
    demandas: queries[3]?.data ?? [],
    acciones: queries[4]?.data ?? [],
    compromisos: queries[5]?.data ?? [],
    fuentes: queries[6]?.data ?? [],
  };
  return { state: 'ready', observations: qualityIssues(data) };
};
