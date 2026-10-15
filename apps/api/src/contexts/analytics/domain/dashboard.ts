import type { RecordsByModule, StoredRecord } from './records.ts';
import { pyStr, pyTruthy } from './python.ts';

export const DASHBOARD_MODULES = [
  'Eventos',
  'Actores',
  'Demandas',
  'Alertas',
  'Directorio_Territorial',
  'Actores_Priorizados',
] as const;

const status = (payload: Readonly<Record<string, unknown>>) =>
  pyStr(payload['Estado'] ?? '').toLowerCase();

/** Calculation rules; the web shows them next to each counter. */
const counters = (of: (module: string) => readonly StoredRecord[]) => ({
  eventos: of('Eventos').length,
  actores: of('Actores').length,
  demandas_abiertas: of('Demandas').filter((r) => status(r.payload) !== 'cerrada').length,
  alertas_activas: of('Alertas').filter(
    (a) => !['cerrada', 'descartada'].includes(status(a.payload)),
  ).length,
  directorio: of('Directorio_Territorial').length,
  priorizados: of('Actores_Priorizados').length,
});

/** Executive counters of the dashboard (app.py:984 `/api/dashboard`). */
export const dashboardSummary = (records: RecordsByModule) => {
  const of = (module: string) => records[module] ?? [];
  const levels: Record<string, number> = {};
  for (const alert of of('Alertas').map((r) => r.payload)) {
    const raw = pyTruthy(alert['Nivel_Preliminar'])
      ? alert['Nivel_Preliminar']
      : pyTruthy(alert['Nivel'])
        ? alert['Nivel']
        : 'Sin nivel';
    const level = pyStr(raw);
    levels[level] = (levels[level] ?? 0) + 1;
  }
  return { ...counters(of), niveles: levels };
};

export type DashboardSummary = ReturnType<typeof dashboardSummary>;
