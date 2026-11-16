import { SituationalAnalysisResponse } from '@sipges/contracts';
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
import { NarrativeOverview } from './NarrativeOverview.tsx';
import styles from './Analysis.module.css';
import { DateText } from '../../shared/ui/DateText.tsx';

/** The record modules whose excerpts the analysis lists. */
export type ExcerptModule = 'eventos' | 'alertas' | 'demandas' | 'actores';

export const SituationalPage = ({
  fieldLabel,
  ...context
}: FeatureContext & {
  /**
   * The record form's label of a stored field. Features never import each other, so the app
   * passes the records feature's labels; without it a field reads as words (functional-10 T3).
   */
  fieldLabel?: (module: ExcerptModule, key: string) => string;
}) => {
  const label = (module: ExcerptModule) =>
    fieldLabel ? (key: string) => fieldLabel(module, key) : undefined;
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
        recomendaciones requieren validación.
      </p>
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
          filename="SIPGES_Analisis_Situacional.docx"
          label="Descargar informe situacional"
        />
      </div>
      <QueryState query={query} label="el análisis situacional">
        {(data) => (
          <>
            <Card title="Estado del proyecto">
              <p className={styles.muted}>
                Generado: <DateText value={data.generated_at} time />. {data.method}
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
            <NarrativeOverview scope={context.scope} />
            <Card title="Observaciones">
              <TextList items={data.observaciones} />
            </Card>
            <Excerpts
              title="Eventos recientes"
              records={data.eventos_recientes}
              fieldLabel={label('eventos')}
            />
            <Excerpts
              title="Alertas prioritarias"
              records={data.alertas_prioritarias}
              fieldLabel={label('alertas')}
            />
            <Excerpts
              title="Demandas abiertas"
              records={data.demandas_abiertas}
              fieldLabel={label('demandas')}
            />
            <Excerpts title="Actores" records={data.actores} fieldLabel={label('actores')} />
            <Card title="Escenarios orientativos">
              {data.escenarios.map((scenario, i) => (
                <article key={i}>
                  <h3>{scenario.nombre}</h3>
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
