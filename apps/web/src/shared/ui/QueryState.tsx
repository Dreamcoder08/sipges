import type { ReactNode } from 'react';
import { isApiError } from '../api/client.ts';
import { Alert } from './Alert.tsx';
import styles from './QueryState.module.css';

/** Loading and error states for one query; children render only with data. */
export const QueryState = <T,>({
  query,
  label,
  children,
}: {
  query: { isPending: boolean; error: unknown; data: T | undefined };
  label: string;
  children: (data: T) => ReactNode;
}) => {
  if (query.error) {
    return (
      <Alert tone="error">
        {isApiError(query.error) ? query.error.detail : `No se pudo cargar ${label}.`}
      </Alert>
    );
  }
  if (query.isPending || query.data === undefined) {
    return (
      <p className={styles.loading} role="status" aria-live="polite">
        <span className={styles.spinner} aria-hidden="true" />
        Cargando {label}…
      </p>
    );
  }
  return <>{children(query.data)}</>;
};
