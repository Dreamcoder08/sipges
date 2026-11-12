import type { IrsaSummary } from '@sipges/contracts';
import { useQuery } from '@tanstack/react-query';
import { LevelPill } from '../../shared/ui/Badges.tsx';
import { IrsaPendingBadge } from '../../shared/ui/IrsaPendingBadge.tsx';
import { irsaConfigQuery } from './api.ts';
import styles from './IrsaStatus.module.css';

/** With no evidence in G, A, D, N or E the level says nothing about risk (insufficient_data). */
export const hasNoEvidence = (irsa: IrsaSummary) => irsa.insufficient_data === true;

/**
 * What stands in for the level pill: the level itself, or neutral text without a risk colour
 * when there is no evidence; plus the badge while the methodology is still unvalidated.
 */
export const IrsaStatus = ({ scope, irsa }: { scope: string; irsa: IrsaSummary }) => {
  const config = useQuery(irsaConfigQuery(scope));
  return (
    <>
      {hasNoEvidence(irsa) ? (
        <span className={styles.noData}>Sin datos suficientes</span>
      ) : (
        <LevelPill level={irsa.level} />
      )}
      <IrsaPendingBadge status={config.data?.status} />
    </>
  );
};

/** The line under the reading that tells the reader what to do about the missing data. */
export const IrsaNoDataHint = ({ irsa }: { irsa: IrsaSummary }) =>
  hasNoEvidence(irsa) ? (
    <p className={styles.hint}>Carga registros del proyecto para calcular el IRSA.</p>
  ) : null;
