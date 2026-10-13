import type { RecordsByModule } from './records.ts';
import { pyStr, pyTruthy } from './python.ts';

export const DASHBOARD_MODULES = [
  'Eventos',
  'Actores',
  'Demandas',
  'Alertas',
  'Directorio_Territorial',
  'Actores_Priorizados',
] as const;

/** Executive counters of the dashboard (app.py:984 `/api/dashboard`). */
export const dashboardSummary = (records: RecordsByModule) => {
  const of = (module: string) => records[module] ?? [];
  const status = (payload: Readonly<Record<string, unknown>>) =>
    pyStr(payload['Estado'] ?? '').toLowerCase();
  const alerts = of('Alertas').map((r) => r.payload);
  const levels: Record<string, number> = {};
  for (const alert of alerts) {
    const raw = pyTruthy(alert['Nivel_Preliminar'])
      ? alert['Nivel_Preliminar']
      : pyTruthy(alert['Nivel'])
        ? alert['Nivel']
        : 'Sin nivel';
    const level = pyStr(raw);
    levels[level] = (levels[level] ?? 0) + 1;
  }
  return {
    eventos: of('Eventos').length,
    actores: of('Actores').length,
    demandas_abiertas: of('Demandas').filter((r) => status(r.payload) !== 'cerrada').length,
    alertas_activas: alerts.filter((a) => !['cerrada', 'descartada'].includes(status(a))).length,
    directorio: of('Directorio_Territorial').length,
    priorizados: of('Actores_Priorizados').length,
    niveles: levels,
  };
};

export type DashboardSummary = ReturnType<typeof dashboardSummary>;
