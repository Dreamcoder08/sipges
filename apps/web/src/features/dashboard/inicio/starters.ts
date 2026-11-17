import type { Level } from '../../../shared/lib/text.ts';

/** The starter questions when the project's state suggests nothing more specific. */
export const GENERIC_STARTERS = [
  '¿Qué demandas siguen abiertas y quién las lidera?',
  'Resume lo ocurrido esta semana',
  '¿Qué compromisos vencen este mes?',
  '¿Qué alertas esperan aprobación?',
] as const;

const MAX_STARTERS = 4;

/**
 * Inicio's starter chips (odd/tasks/chat-first-ui.md T4): questions the project's state makes
 * worth asking come first, from data the page already loaded (no request of their own), then the
 * generic set fills up to four. A red alert that is still open asks about red alerts.
 */
export const starterQuestions = ({
  openAlerts,
}: {
  /** Open alerts at Amarillo or above, as the attention list reads them; undefined while loading. */
  openAlerts?: readonly { level: Level }[] | undefined;
}): string[] => {
  const fromState = openAlerts?.some((alert) => alert.level === 'Rojo')
    ? ['¿Qué alertas rojas siguen abiertas?']
    : [];
  return [...new Set([...fromState, ...GENERIC_STARTERS])].slice(0, MAX_STARTERS);
};
