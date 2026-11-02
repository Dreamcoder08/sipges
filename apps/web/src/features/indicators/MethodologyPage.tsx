import { useQuery } from '@tanstack/react-query';
import type { FeatureContext } from '../../shared/api/feature-context.ts';
import { Alert } from '../../shared/ui/Alert.tsx';
import { Card } from '../../shared/ui/Card.tsx';
import { QueryState } from '../../shared/ui/QueryState.tsx';
import { indicatorsQuery, modelQuery } from './api.ts';
import { IndicatorTable } from './IndicatorTable.tsx';
import styles from './Indicators.module.css';
export const MethodologyPage = ({ scope, projectLabel }: FeatureContext) => {
  const report = useQuery(indicatorsQuery(scope));
  const model = useQuery(modelQuery(scope));
  return (
    <div className={styles.page}>
      <p>Metodología e indicadores · {projectLabel}</p>
      <Card title="Cómo se calcula el IRSA">
        <p>
          El índice agrega las puntuaciones dimensionales G, A, D, N, E e I multiplicadas por sus
          pesos configurados. Cada dimensión promedia sus indicadores calculables. La ausencia de
          datos no equivale a ausencia de riesgo.
        </p>
        <p>
          Los puntajes se obtienen de reglas transparentes sobre los registros del proyecto. Los
          factores y la disponibilidad permiten revisar el origen del cálculo; no estiman
          probabilidad ni impacto medido.
        </p>
        <QueryState query={model} label="estado metodológico">
          {(data) => (
            <>
              <p>Versión: {data.version}</p>
              <Alert tone="info">{data.content_validation}</Alert>
              <p>{data.release_rule}</p>
            </>
          )}
        </QueryState>
      </Card>
      <Card title="Cómo se calcula el riesgo de conflicto">
        <p>
          Análisis › Riesgo de conflicto ordena localidades y actores por su probabilidad de escalar
          en 30 y 90 días. Escalar es registrar una alerta roja o naranja, una alerta territorial
          alta o un evento grave que no se descartó. Cada unidad suma nueve factores con pesos
          fijos: demandas abiertas, compromisos vencidos, narrativas críticas y su aumento, alertas,
          escalamientos recientes, IRSA del proyecto y su subida, y actividad reciente. Cada factor
          enlaza a los registros que lo sustentan.
        </p>
        <p>
          El puntaje se convierte en probabilidad con el historial del propio proyecto: se mide qué
          pasó después de cortes pasados usando solo lo registrado hasta cada corte, se entrena con
          los cortes antiguos y se evalúa con los recientes (puntaje de Brier frente a la tasa
          base). Si el historial no alcanza, no se muestra porcentaje y la confianza es baja. Se
          calcula dentro de SIPGES, sin IA externa.
        </p>
      </Card>
      <Card title="Definiciones, métodos y evidencias">
        <QueryState query={report} label="indicadores">
          {(data) => (
            <>
              <Alert tone="info">{data.validation_status}</Alert>
              <p>{data.method_note}</p>
              <IndicatorTable items={data.indicators} />
            </>
          )}
        </QueryState>
      </Card>
    </div>
  );
};
