import type { IrsaSummary, TerritorialAlerts } from '@sipges/contracts';
import type { z } from 'zod';
import { objectHref } from '../../../shared/lib/navigation.tsx';
import type { Level } from '../../../shared/lib/text.ts';
import { hasNoEvidence } from '../IrsaStatus.tsx';
import type { TodayItem } from '../model.ts';

/** One row of «Necesita tu atención»: what it is, a line of context and the one next step. */
export type AttentionItem = {
  key: string;
  title: string;
  meta: string;
  level?: Level;
  href: string;
  action: string;
};

/** The digital alert state Bandeja › Pendientes decides (contracts AlertState). */
const AWAITING = 'Pendiente de verificación';
const MAX_ROWS = 5;

const day = (date: string) =>
  /^\d{4}-\d{2}-\d{2}/.test(date)
    ? new Date(`${date.slice(0, 10)}T12:00:00`).toLocaleDateString('es-PE', {
        day: 'numeric',
        month: 'short',
      })
    : null;

/**
 * Inicio's attention list from data other screens already load: digital alerts awaiting
 * verification (one row, decided in Bandeja), open alerts at Amarillo or above, and an IRSA that
 * cannot be computed. Sources that have not loaded add nothing; at most five rows.
 */
export const attentionItems = ({
  alerts,
  digital,
  irsa,
}: {
  alerts: readonly (TodayItem & { level: Level })[];
  digital?: z.infer<typeof TerritorialAlerts>;
  irsa?: IrsaSummary;
}): AttentionItem[] => {
  const awaiting = digital?.filter((alert) => alert.status === AWAITING).length ?? 0;
  return [
    ...(awaiting
      ? [
          {
            key: 'digital',
            title:
              awaiting === 1
                ? '1 alerta digital espera verificación'
                : `${awaiting} alertas digitales esperan verificación`,
            meta: 'Bandeja › Pendientes',
            href: '/bandeja',
            action: 'Revisar en Bandeja',
          },
        ]
      : []),
    ...alerts.map((alert) => ({
      key: `alerta:${alert.id}`,
      title: alert.title,
      meta: ['Alerta activa', day(alert.date)].filter(Boolean).join(' · '),
      level: alert.level,
      href: objectHref('alertas', alert.id),
      action: 'Abrir alerta',
    })),
    ...(irsa && hasNoEvidence(irsa)
      ? [
          {
            key: 'irsa',
            title: 'El IRSA no tiene datos suficientes',
            meta: 'Carga registros del proyecto para calcular el IRSA.',
            href: '/registros',
            action: 'Ir a Registros',
          },
        ]
      : []),
  ].slice(0, MAX_ROWS);
};
