import type { CurrentScope } from '@sipges/contracts';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useId } from 'react';
import { scopeKey, scopesQuery, selectProject } from './api.ts';
import styles from './ProjectSwitcher.module.css';

/** Active project selector; switching asks the server, then every query is refetched. */
export const ProjectSwitcher = ({
  current,
  onSwitched,
}: {
  current: CurrentScope;
  onSwitched: () => void | Promise<void>;
}) => {
  const id = useId();
  const scopes = useQuery(scopesQuery);
  const mutation = useMutation({ mutationFn: selectProject, onSuccess: () => onSwitched() });
  const options = scopes.data ?? [];
  return (
    <div className={styles.switcher}>
      <label htmlFor={id}>Proyecto activo</label>
      <select
        id={id}
        value={current.scope}
        disabled={mutation.isPending || options.length < 2}
        onChange={(event) => mutation.mutate(event.target.value)}
      >
        {options.length ? (
          options.map((scope) => (
            <option key={scopeKey(scope)} value={scopeKey(scope)}>
              {scope.label || scope.project_id}
            </option>
          ))
        ) : (
          <option value={current.scope}>{current.project_id}</option>
        )}
      </select>
      {mutation.isError ? (
        <span role="alert" className={styles.error}>
          No se pudo cambiar de proyecto.
        </span>
      ) : null}
    </div>
  );
};
