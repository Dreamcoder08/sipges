import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { isApiError } from '../../shared/api/client.ts';
import { Alert } from '../../shared/ui/Alert.tsx';
import { Button } from '../../shared/ui/Button.tsx';
import { QueryState } from '../../shared/ui/QueryState.tsx';

import { decideProposal, proposalsQuery } from './ontology-api.ts';
import styles from './Records.module.css';

type Decision = { fingerprint: string; decision: 'approve' | 'reject' };

/**
 * Actions the analyst proposes for this record (docs/adr/0014 §8). Nothing changes until a
 * person approves; approvals and rejections are audited and never proposed again.
 */
export const ProposalsPanel = ({
  module,
  id,
  scope,
}: {
  module: string;
  id: string;
  scope: string;
}) => {
  const client = useQueryClient();
  const proposals = useQuery(proposalsQuery(module, id, scope));
  const decide = useMutation({
    mutationFn: (d: Decision) => decideProposal(scope, { module, id, ...d }),
    onSettled: () => client.invalidateQueries({ queryKey: ['records', scope] }),
  });
  return (
    <section className={styles.evidence} aria-labelledby={`proposals-${id}`}>
      <h4 id={`proposals-${id}`}>Propuestas del analista</h4>
      {decide.error ? (
        <Alert tone="error">
          {isApiError(decide.error) ? decide.error.detail : 'No se pudo guardar la decisión.'}
        </Alert>
      ) : null}
      <QueryState query={proposals} label="las propuestas">
        {(items) =>
          items.length === 0 ? (
            <p className={styles.muted}>Sin propuestas pendientes para este registro.</p>
          ) : (
            <ul className={styles.proposals}>
              {items.map((item) => (
                <li key={item.fingerprint}>
                  <strong>{item.title}</strong>
                  <p className={styles.muted}>{item.reason}</p>
                  <div className={styles.proposalActions}>
                    <Button
                      disabled={decide.isPending}
                      onClick={() =>
                        decide.mutate({ fingerprint: item.fingerprint, decision: 'approve' })
                      }
                    >
                      Aprobar
                    </Button>
                    <Button
                      variant="secondary"
                      disabled={decide.isPending}
                      onClick={() =>
                        decide.mutate({ fingerprint: item.fingerprint, decision: 'reject' })
                      }
                    >
                      Descartar
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          )
        }
      </QueryState>
    </section>
  );
};
