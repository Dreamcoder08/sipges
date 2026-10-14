import { SituationalAnalysisResponse } from '@mascli/contracts';
import { useQuery } from '@tanstack/react-query';
import { requestJson } from '../../shared/api/client.ts';
import type { FeatureContext } from '../../shared/api/feature-context.ts';
import { Button } from '../../shared/ui/Button.tsx';
import { Card } from '../../shared/ui/Card.tsx';
import { QueryState } from '../../shared/ui/QueryState.tsx';
import {
  Counts,
  Excerpts,
  Limitations,
  ReportDownload,
  Tallies,
  TextList,
} from './ReportParts.tsx';
import { DocumentLab } from './DocumentLab.tsx';
import { DemoDataNotice } from '../../shared/ui/DemoDataNotice.tsx';
import styles from './Analysis.module.css';

export const SituationalPage = (context: FeatureContext) => {
  const query = useQuery({
    queryKey: ['analysis', context.scope, 'situational'],
    queryFn: ({ signal }) =>
      requestJson('/system/situational-analysis', SituationalAnalysisResponse, {
        scope: context.scope,
        signal,
      }),
  });
  return (
    <div className={styles.page}>
      <p>
        Diagnóstico del proyecto {context.projectLabel} a partir de sus registros. Las
        recomendaciones requieren contraste humano.
      </p>
      <DemoDataNotice scope={context.scope} />
      <div className={styles.actions}>
        <Button
          variant="secondary"
          disabled={query.isFetching}
          onClick={() => void query.refetch()}
        >
          Actualizar análisis
        </Button>
        <ReportDownload
          scope={context.scope}
          path="/system/situational-report.docx"
          filename="MASCLI_Analisis_Situacional.docx"
          label="Descargar informe situacional"
        />
      </div>
      <QueryState query={query} label="el análisis situacional">
        {(data) => (
          <>
            <Card title="Estado del proyecto">
              <p className={styles.muted}>
                Generado: {data.generated_at}. {data.method}
              </p>
              <Counts values={data.counts} />
              <Counts
                values={{
                  'Alertas activas': data.alertas_activas,
                  'Demandas pendientes': data.demandas_pendientes,
                }}
              />
            </Card>
            <div className={styles.grid}>
              <Tallies title="Territorios" rows={data.territorios} />
              <Tallies title="Temas de demanda" rows={data.temas_demanda} />
              <Tallies title="Niveles de alerta" rows={data.niveles_alerta} />
            </div>
            <Card title="Observaciones">
              <TextList items={data.observaciones} />
            </Card>
            <Excerpts title="Eventos recientes" records={data.eventos_recientes} />
            <Excerpts title="Alertas prioritarias" records={data.alertas_prioritarias} />
            <Excerpts title="Demandas abiertas" records={data.demandas_abiertas} />
            <Excerpts title="Actores" records={data.actores} />
            <Card title="Escenarios orientativos">
              {data.escenarios.map((scenario, i) => (
                <article key={i}>
                  <h4>{scenario.nombre}</h4>
                  <p>{scenario.supuesto}</p>
                </article>
              ))}
            </Card>
            <Card title="Recomendaciones para revisión">
              <TextList items={data.recomendaciones} />
            </Card>
            <Limitations items={data.limitations} />
          </>
        )}
      </QueryState>
      <DocumentLab {...context} />
    </div>
  );
};
