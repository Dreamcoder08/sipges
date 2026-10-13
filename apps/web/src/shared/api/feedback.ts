import { isApiError } from './client.ts';

export const errorDetail = (error: unknown, fallback = 'No se pudo completar la operación.') =>
  isApiError(error) ? error.detail : fallback;
