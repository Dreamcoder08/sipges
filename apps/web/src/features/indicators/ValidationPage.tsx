import type { ValidationTemplate } from '@mascli/contracts';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { saveBlob } from '../../shared/api/download.ts';
import type { FeatureContext } from '../../shared/api/feature-context.ts';
import { Alert } from '../../shared/ui/Alert.tsx';
import { Button } from '../../shared/ui/Button.tsx';
import { Card } from '../../shared/ui/Card.tsx';
import { QueryState } from '../../shared/ui/QueryState.tsx';
import { modelQuery, templateQuery } from './api.ts';
import styles from './Indicators.module.css';

const csvCell = (value: string | null) => {
  const text = value ?? '';
  const safe = /^[\s]*[=+@-]/.test(text) ? `'${text}` : text;
  return `"${safe.replaceAll('"', '""')}"`;
};
export const validationCsv = (template: ValidationTemplate) => {
  const columns = [
    'dimension',
    'code',
    'name',
    'definition',
    'expert_1',
    'expert_2',
    'expert_3',
    'expert_4',
    'expert_5',
    'aiken_v',
    'decision',
  ] as const;
  return (
    '\uFEFF' +
    [
      columns.join(','),
      ...template.rows.map((row) => columns.map((column) => csvCell(row[column])).join(',')),
    ].join('\r\n')
  );
};
export const ValidationPage = (context: FeatureContext) => (
  <ValidationWorkspace key={context.scope} {...context} />
);
const ValidationWorkspace = ({ scope, projectLabel }: FeatureContext) => {
  const model = useQuery(modelQuery(scope));
  const template = useQuery(templateQuery(scope));
  const [error, setError] = useState('');
  return (
    <div className={styles.page}>
      <p>Validación de indicadores · {projectLabel}</p>
      <Alert tone="info">
        La paridad funcional del software no acredita validez científica. La valoración de expertos
        y la calibración permanecen pendientes.
      </Alert>
      <Card title="Estado declarado del modelo">
        <QueryState query={model} label="estado del modelo">
          {(data) => (
            <dl className={styles.facts}>
              <dt>Versión</dt>
              <dd>{data.version}</dd>
              <dt>Validación de contenido</dt>
              <dd>{data.content_validation}</dd>
              <dt>Validación funcional</dt>
              <dd>{data.functional_validation ?? 'No declarada'}</dd>
              <dt>Condición de publicación</dt>
              <dd>{data.release_rule}</dd>
            </dl>
          )}
        </QueryState>
      </Card>
      <Card title="Plantilla para revisión de expertos">
        <p>
          Descargue la plantilla y registre las valoraciones fuera de la aplicación. Esta pantalla
          no guarda opiniones ni certifica el modelo; no hay un endpoint de certificación.
        </p>
        <QueryState query={template} label="plantilla de validación">
          {(data) => (
            <>
              <p>Estado: {data.status}</p>
              <Button
                onClick={() => {
                  try {
                    saveBlob(
                      new Blob([validationCsv(data)], { type: 'text/csv;charset=utf-8' }),
                      'validacion-indicadores.csv',
                    );
                    setError('');
                  } catch {
                    setError('No se pudo descargar la plantilla.');
                  }
                }}
              >
                Descargar plantilla CSV
              </Button>
              <div
                className={styles.table}
                tabIndex={0}
                role="region"
                aria-label="Plantilla de expertos"
              >
                <table>
                  <caption>Indicadores pendientes de revisión</caption>
                  <thead>
                    <tr>
                      <th scope="col">Código / dimensión</th>
                      <th scope="col">Indicador</th>
                      <th scope="col">Definición</th>
                      <th scope="col">Expertos 1–5</th>
                      <th scope="col">V de Aiken</th>
                      <th scope="col">Decisión</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.rows.map((row) => (
                      <tr key={row.code}>
                        <th scope="row">
                          {row.code} / {row.dimension}
                        </th>
                        <td>{row.name}</td>
                        <td>{row.definition}</td>
                        <td>
                          {[row.expert_1, row.expert_2, row.expert_3, row.expert_4, row.expert_5]
                            .map((x) => x ?? 'Sin valoración')
                            .join(' · ')}
                        </td>
                        <td>{row.aiken_v ?? 'No calculado'}</td>
                        <td>{row.decision}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {data.rows.length === 0 ? <p>No hay indicadores en la plantilla.</p> : null}
              </div>
            </>
          )}
        </QueryState>
        {error ? <Alert tone="error">{error}</Alert> : null}
      </Card>
    </div>
  );
};
