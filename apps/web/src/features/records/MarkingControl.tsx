import type { MarkingIn } from '@sipges/contracts';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useId } from 'react';
import { isApiError } from '../../shared/api/client.ts';
import { Alert } from '../../shared/ui/Alert.tsx';
import { setMarking } from './ontology-api.ts';
import styles from './Records.module.css';

type Marking = MarkingIn['marking'];

export const MARKING_LABELS: Record<Marking, string> = {
  publico: 'Público',
  interno: 'Interno',
  restringido: 'Restringido',
};

/** Classification badge; writers can change it (docs/adr/0012). */
export const MarkingControl = ({
  module,
  id,
  scope,
  marking,
  writable,
}: {
  module: string;
  id: string;
  scope: string;
  marking: Marking;
  writable: boolean;
}) => {
  const selectId = useId();
  const client = useQueryClient();
  const change = useMutation({
    mutationFn: (next: Marking) => setMarking(scope, { module, id, marking: next }),
    onSuccess: () => client.invalidateQueries({ queryKey: ['records', scope] }),
  });
  return (
    <div className={styles.marking}>
      <span className={`${styles.markingBadge} ${styles[`marking_${marking}`] ?? ''}`}>
        {MARKING_LABELS[marking]}
      </span>
      {writable ? (
        <>
          <label htmlFor={selectId} className="visually-hidden">
            Clasificación del registro
          </label>
          <select
            id={selectId}
            value={marking}
            disabled={change.isPending}
            onChange={(event) => change.mutate(event.target.value as Marking)}
          >
            {(Object.keys(MARKING_LABELS) as Marking[]).map((value) => (
              <option key={value} value={value}>
                {MARKING_LABELS[value]}
              </option>
            ))}
          </select>
        </>
      ) : null}
      {change.error ? (
        <Alert tone="error">
          {isApiError(change.error) ? change.error.detail : 'No se pudo clasificar.'}
        </Alert>
      ) : null}
      {marking === 'restringido' ? (
        <small>Solo lo ven administradores, analistas y coordinadores.</small>
      ) : null}
    </div>
  );
};
