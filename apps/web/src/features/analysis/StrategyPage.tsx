import {
  ConsensusEngineResponse,
  IntegratedAnalysisResponse,
  StrategicAssessmentResponse,
} from '@mascli/contracts';
import { useQuery } from '@tanstack/react-query';
import { type ReactNode, useState } from 'react';
import { requestJson } from '../../shared/api/client.ts';
import type { FeatureContext } from '../../shared/api/feature-context.ts';
import { Alert } from '../../shared/ui/Alert.tsx';
import { Button } from '../../shared/ui/Button.tsx';
import { Card } from '../../shared/ui/Card.tsx';
import { QueryState } from '../../shared/ui/QueryState.tsx';
import { Counts, Limitations, ReportDownload, TextList } from './ReportParts.tsx';
import { DemoDataNotice } from '../../shared/ui/DemoDataNotice.tsx';
import styles from './Analysis.module.css';

export type StrategicRecordModule = 'intereses' | 'dialogos' | 'oportunidades' | 'hechos' | 'aarc';
const modules: Array<[StrategicRecordModule, string]> = [
  ['intereses', 'Intereses'],
  ['dialogos', 'Diálogos'],
  ['oportunidades', 'Oportunidades'],
  ['hechos', 'Hechos por verificar'],
  ['aarc', 'AARC'],
];
export const StrategyPage = (
  context: FeatureContext & { renderRecords: (module: StrategicRecordModule) => ReactNode },
) => {
  const [module, setModule] = useState<StrategicRecordModule>('intereses');
  const assessment = useQuery({
    queryKey: ['analysis', context.scope, 'strategic'],
    queryFn: ({ signal }) =>
      requestJson('/system/strategic-assessment', StrategicAssessmentResponse, {
        scope: context.scope,
        signal,
      }),
  });
  const consensus = useQuery({
    queryKey: ['analysis', context.scope, 'consensus'],
    queryFn: ({ signal }) =>
      requestJson('/system/consensus-engine', ConsensusEngineResponse, {
        scope: context.scope,
        signal,
      }),
  });
  const integrated = useQuery({
    queryKey: ['analysis', context.scope, 'integrated'],
    queryFn: ({ signal }) =>
      requestJson('/system/integrated-analysis', IntegratedAnalysisResponse, {
        scope: context.scope,
        signal,
      }),
  });
  const busy = assessment.isFetching || consensus.isFetching || integrated.isFetching;
  return (
    <div className={styles.page}>
      <Alert tone="info">
        Los cruces y planes son candidatos para revisión. Esta pantalla no crea compromisos ni
        ejecuta acciones automáticamente.
      </Alert>
      <DemoDataNotice scope={context.scope} />
      <div className={styles.actions}>
        <Button
          variant="secondary"
          disabled={busy}
          onClick={() =>
            void Promise.all([assessment.refetch(), consensus.refetch(), integrated.refetch()])
          }
        >
          Actualizar análisis estratégico
        </Button>
        <ReportDownload
          scope={context.scope}
          path="/system/strategic-report.docx"
          filename="MASCLI_Informe_Estrategico.docx"
          label="Descargar informe estratégico"
        />
        <ReportDownload
          scope={context.scope}
          path="/system/consensus-engine.docx"
          filename="MASCLI_Motor_Valor_Consenso.docx"
          label="Descargar propuestas de consenso"
        />
        <ReportDownload
          scope={context.scope}
          path="/system/integrated-analysis.docx"
          filename="MASCLI_RC19_Analisis_Integrado.docx"
          label="Descargar análisis integrado"
        />
      </div>
      <QueryState query={assessment} label="la evaluación estratégica">
        {(data) => (
          <>
            <Card title="Evaluación estratégica">
              <p className={styles.muted}>Generado: {data.generated_at}</p>
              <Counts values={data.counts} />
              <Counts
                values={{
                  'Hechos pendientes': data.facts_pending,
                  'Oportunidades abiertas': data.opportunities_open,
                  'Diálogos abiertos': data.dialogues_open,
                  'AARC completos': data.aarc_complete,
                }}
              />
              <TextList items={data.attention} />
            </Card>
            <Limitations items={data.limitations} />
          </>
        )}
      </QueryState>
      <QueryState query={consensus} label="las propuestas de consenso">
        {(data) => (
          <>
            <Card title="Propuestas de consenso">
              <p>{data.method}</p>
              <Counts
                values={{
                  Propuestas: data.summary.total,
                  'Prioridad alta orientativa': data.summary.alta,
                }}
              />
              {data.recommendations.length ? (
                data.recommendations.map((item, i) => (
                  <article className={styles.item} key={i}>
                    <h4>{item.titulo}</h4>
                    <p>{item.motivo}</p>
                    <p>{item.accion_sugerida}</p>
                    <dl>
                      <dt>Origen</dt>
                      <dd>{item.origen}</dd>
                      <dt>Registros relacionados</dt>
                      <dd>{item.registros_relacionados.join(', ') || 'Sin registros'}</dd>
                      <dt>Prioridad orientativa</dt>
                      <dd>{item.prioridad_orientativa}</dd>
                      <dt>Estado</dt>
                      <dd>{item.estado}</dd>
                      <dt>Autorización</dt>
                      <dd>{item.autorizacion}</dd>
                    </dl>
                  </article>
                ))
              ) : (
                <p>Sin propuestas disponibles.</p>
              )}
            </Card>
            <Limitations items={data.limitations} />
          </>
        )}
      </QueryState>
      <QueryState query={integrated} label="el análisis integrado">
        {(data) => (
          <>
            <Card title="Análisis integrado">
              <Counts values={data.summary} />
              <h4>Cruces candidatos</h4>
              {data.candidate_links.length ? (
                data.candidate_links.map((item, i) => (
                  <article className={styles.item} key={i}>
                    <p>
                      {item.origen} → {item.destino}
                    </p>
                    <p>{item.criterio}</p>
                    <p>Términos compartidos: {item.terminos_compartidos.join(', ')}</p>
                    <p>
                      {item.estado}. {item.uso_sugerido}
                    </p>
                  </article>
                ))
              ) : (
                <p>Sin cruces candidatos.</p>
              )}
              <h4>Plan sugerido para revisión</h4>
              {data.action_plan.length ? (
                data.action_plan.map((item) => (
                  <article className={styles.item} key={item.numero}>
                    <h4>
                      {item.numero}. {item.accion}
                    </h4>
                    <p>{item.objetivo}</p>
                    <p>Fundamento: {item.fundamento}</p>
                    <p>Registros: {item.registros.join(', ')}</p>
                    <p>
                      Prioridad orientativa: {item.prioridad_orientativa}. Responsable:{' '}
                      {item.responsable}. Plazo: {item.plazo}.
                    </p>
                    <p>{item.estado}</p>
                  </article>
                ))
              ) : (
                <p>Sin acciones sugeridas.</p>
              )}
              <h4>Escenarios orientativos</h4>
              {data.scenarios.map((item, i) => (
                <article className={styles.item} key={i}>
                  <h4>{item.tipo}</h4>
                  <p>{item.supuesto}</p>
                  <TextList items={item.indicadores_a_observar} />
                </article>
              ))}
            </Card>
            <Limitations items={data.limitations} />
          </>
        )}
      </QueryState>
      <Card title="Registros estratégicos">
        <div className={styles.tabs} role="group" aria-label="Elegir módulo estratégico">
          {modules.map(([id, label]) => (
            <Button
              key={id}
              variant={module === id ? 'primary' : 'secondary'}
              aria-pressed={module === id}
              onClick={() => setModule(id)}
            >
              {label}
            </Button>
          ))}
        </div>
      </Card>
      <div key={module}>{context.renderRecords(module)}</div>
    </div>
  );
};
