import type { ReactNode } from 'react';
import { isApiError } from '../api/client.ts';
import { Alert } from './Alert.tsx';
import { Button } from './Button.tsx';
import { Skeleton } from './Skeleton.tsx';
import styles from './QueryState.module.css';

/**
 * Loading and error states for one query; children render only with data. Loading shows the
 * shape of the content under a spoken status; an error offers a retry when the query has one.
 */
export const QueryState = <T,>({
  query,
  label,
  children,
}: {
  query: {
    isPending: boolean;
    error: unknown;
    data: T | undefined;
    refetch?: () => unknown;
    isFetching?: boolean;
  };
  label: string;
  children: (data: T) => ReactNode;
}) => {
  if (query.error) {
    const { refetch } = query;
    return (
      <div className={styles.error}>
        <Alert tone="error">
          {isApiError(query.error) ? query.error.detail : `No se pudo cargar ${label}.`}
        </Alert>
        {refetch ? (
          <Button
            variant="secondary"
            size="sm"
            disabled={query.isFetching}
            onClick={() => refetch()}
          >
            Reintentar
          </Button>
        ) : null}
      </div>
    );
  }
  if (query.isPending || query.data === undefined) {
    return (
      <div className={styles.loading}>
        <p className={styles.status} role="status" aria-live="polite">
          <span className={styles.spinner} aria-hidden="true" />
          Cargando {label}…
        </p>
        <Skeleton />
      </div>
    );
  }
  return <>{children(query.data)}</>;
};
