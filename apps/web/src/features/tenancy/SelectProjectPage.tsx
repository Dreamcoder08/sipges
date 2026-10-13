import { useMutation, useQuery } from '@tanstack/react-query';
import { Alert } from '../../shared/ui/Alert.tsx';
import { Button } from '../../shared/ui/Button.tsx';
import { scopeKey, scopesQuery, selectProject } from './api.ts';
import styles from './SelectProjectPage.module.css';

/** Shown when the user has several projects and none is active yet. */
export const SelectProjectPage = ({ onSelected }: { onSelected: () => void | Promise<void> }) => {
  const scopes = useQuery(scopesQuery);
  const mutation = useMutation({ mutationFn: selectProject, onSuccess: () => onSelected() });
  return (
    <main className={styles.page}>
      <section className={styles.card} aria-labelledby="select-project-title">
        <h1 id="select-project-title">Seleccione un proyecto</h1>
        <p>Los datos, reportes y auditoría se limitan al proyecto activo.</p>
        {scopes.isError || mutation.isError ? (
          <Alert tone="error">No se pudo cargar o seleccionar el proyecto.</Alert>
        ) : null}
        {scopes.isPending ? <p aria-live="polite">Cargando proyectos…</p> : null}
        {scopes.data?.length === 0 ? (
          <Alert tone="info">
            Su cuenta no tiene proyectos asignados. Contacte a un administrador.
          </Alert>
        ) : null}
        <ul className={styles.list}>
          {scopes.data?.map((scope) => (
            <li key={scopeKey(scope)}>
              <Button
                variant="secondary"
                disabled={mutation.isPending}
                onClick={() => mutation.mutate(scopeKey(scope))}
              >
                <b>{scope.label || scope.project_id}</b>
                <small>{scopeKey(scope)}</small>
              </Button>
            </li>
          ))}
        </ul>
      </section>
    </main>
  );
};
