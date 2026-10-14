import { IrsaConfigResponse, IrsaSnapshotResponse, type IrsaConfig } from '@mascli/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { requestJson } from '../../shared/api/client.ts';
import { errorDetail } from '../../shared/api/feedback.ts';
import type { FeatureContext } from '../../shared/api/feature-context.ts';
import { Alert } from '../../shared/ui/Alert.tsx';
import { Button } from '../../shared/ui/Button.tsx';
import { Card } from '../../shared/ui/Card.tsx';
import { Field } from '../../shared/ui/Field.tsx';
import { QueryState } from '../../shared/ui/QueryState.tsx';
import { LineChart, RadarChart } from '../../shared/ui/charts/Charts.tsx';
import { configQuery, historyQuery, irsaQuery } from './api.ts';
import { IndicatorTable } from './IndicatorTable.tsx';
import styles from './Indicators.module.css';

const dimensions = ['G', 'A', 'D', 'N', 'E', 'I'] as const;
export const IrsaPage = (context: FeatureContext) => (
  <IrsaWorkspace key={context.scope} {...context} />
);
const IrsaWorkspace = ({ scope, projectLabel, role }: FeatureContext) => {
  const report = useQuery(irsaQuery(scope));
  const config = useQuery(configQuery(scope));
  const history = useQuery(historyQuery(scope));
  const client = useQueryClient();
  const [note, setNote] = useState('');
  const [notice, setNotice] = useState('');
  const snapshot = useMutation({
    mutationFn: (value: string) =>
      requestJson('/system/irsa/snapshot', IrsaSnapshotResponse, {
        scope,
        method: 'POST',
        body: { json: { payload: { note: value } } },
      }),
    onSuccess: async () => {
      setNotice('Corte IRSA guardado.');
      setNote('');
      await client.invalidateQueries({ queryKey: ['indicators', scope, 'history'] });
    },
  });
  return (
    <div className={styles.page}>
      <p>Índice de riesgo socioambiental · {projectLabel}</p>
      <Card title="IRSA actual">
        <QueryState query={report} label="IRSA">
          {(data) => (
            <>
              <p className={styles.score}>
                {data.irsa.toFixed(2)} / 100 · {data.level}
              </p>
              <Alert tone="info">{data.status}</Alert>
              <p>Versión de configuración: {data.config_version}</p>
              {data.notes.map((note) => (
                <p key={note}>{note}</p>
              ))}
              <div className={styles.split}>
                <div className={styles.radar}>
                  <RadarChart
                    caption="Puntuación IRSA por dimensión (0 a 100)"
                    data={dimensions.map((d) => ({ key: d, label: d, value: data.scores[d] }))}
                  />
                </div>
                <div
                  className={styles.table}
                  tabIndex={0}
                  role="region"
                  aria-label="Puntuaciones por dimensión"
                >
                  <table>
                    <caption>Puntuación y disponibilidad por dimensión</caption>
                    <thead>
                      <tr>
                        <th scope="col">Dimensión</th>
                        <th scope="col">Puntuación</th>
                        <th scope="col">Peso</th>
                        <th scope="col">Disponibilidad</th>
                      </tr>
                    </thead>
                    <tbody>
                      {dimensions.map((d) => (
                        <tr key={d}>
                          <th scope="row">{d}</th>
                          <td>{data.scores[d].toFixed(2)}</td>
                          <td>{data.weights[d] ?? 0}</td>
                          <td>{data.availability[d].toFixed(1)}%</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
              <p>
                La disponibilidad mide cuántos indicadores son calculables; no representa precisión
                científica.
              </p>
              <details>
                <summary>Factores que explican el índice</summary>
                {data.drivers.length ? (
                  <ul>
                    {data.drivers.map((driver) => (
                      <li key={`${driver.dimension}/${driver.id}`}>
                        {driver.id} · {driver.label}: {driver.points.toFixed(2)} puntos
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p>No hay factores calculables.</p>
                )}
              </details>
              <details>
                <summary>Ver todos los indicadores</summary>
                <IndicatorTable items={data.indicators} />
              </details>
            </>
          )}
        </QueryState>
        <Button
          variant="secondary"
          onClick={() => void report.refetch()}
          disabled={report.isFetching}
        >
          Actualizar IRSA
        </Button>
      </Card>
      {role === 'admin' || role === 'analista' ? (
        <Card title="Guardar corte">
          <form
            className={styles.form}
            onSubmit={(event) => {
              event.preventDefault();
              if (!snapshot.isPending) {
                setNotice('');
                snapshot.mutate(note);
              }
            }}
          >
            <Field
              label="Nota del corte"
              value={note}
              maxLength={4000}
              disabled={snapshot.isPending}
              onChange={(e) => setNote(e.target.value)}
            />
            <Button type="submit" disabled={snapshot.isPending || !report.data}>
              {snapshot.isPending ? 'Guardando corte…' : 'Guardar corte IRSA'}
            </Button>
          </form>
          {snapshot.error ? <Alert tone="error">{errorDetail(snapshot.error)}</Alert> : null}
          {notice ? <Alert tone="success">{notice}</Alert> : null}
        </Card>
      ) : (
        <Alert tone="info">Su rol permite consultar el IRSA y su historial.</Alert>
      )}
      <Card title="Historial de cortes">
        <QueryState query={history} label="historial">
          {(rows) => (
            <>
              <LineChart
                caption="Evolución del IRSA en los cortes guardados"
                empty="Guarde al menos dos cortes para ver la evolución del índice."
                data={[...rows]
                  .sort((a, b) => a.ts.localeCompare(b.ts))
                  .map((row) => ({
                    key: String(row.id),
                    label: row.ts.slice(5, 10),
                    value: Math.round(row.irsa * 10) / 10,
                  }))}
              />
              <div className={styles.table} tabIndex={0} role="region" aria-label="Historial IRSA">
                <table>
                  <caption>Últimos 50 cortes del proyecto</caption>
                  <thead>
                    <tr>
                      <th scope="col">Fecha</th>
                      <th scope="col">IRSA / nivel</th>
                      <th scope="col">Versión</th>
                      <th scope="col">Nota</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((row) => (
                      <tr key={row.id}>
                        <td>{row.ts}</td>
                        <td>
                          {row.irsa.toFixed(2)} / {row.level}
                        </td>
                        <td>{row.config_version ?? 'Sin versión'}</td>
                        <td>{row.note || 'Sin nota'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {rows.length === 0 ? <p>No se han guardado cortes.</p> : null}
              </div>
            </>
          )}
        </QueryState>
      </Card>
      <Card title="Parámetros del índice">
        <QueryState query={config} label="configuración">
          {(data) =>
            role === 'admin' ? (
              <ConfigurationForm scope={scope} config={data} />
            ) : (
              <>
                <p>Solo un administrador puede modificar los parámetros.</p>
                <ul>
                  {Object.entries(data.weights).map(([key, value]) => (
                    <li key={key}>
                      Peso {key}: {value}
                    </li>
                  ))}
                </ul>
              </>
            )
          }
        </QueryState>
      </Card>
    </div>
  );
};

const ConfigurationForm = ({ scope, config }: { scope: string; config: IrsaConfig }) => {
  const [weights, setWeights] = useState(
    Object.fromEntries(Object.entries(config.weights).map(([key, value]) => [key, String(value)])),
  );
  const [thresholds, setThresholds] = useState<Record<string, [string, string]>>(
    Object.fromEntries(
      Object.entries(config.thresholds).map(([key, [low, high]]) => [
        key,
        [String(low), String(high)],
      ]),
    ),
  );
  const [contributions, setContributions] = useState(
    Object.fromEntries(
      Object.entries(config.contributions).map(([key, value]) => [key, String(value)]),
    ),
  );
  const [validation, setValidation] = useState('');
  const [notice, setNotice] = useState('');
  const client = useQueryClient();
  const save = useMutation({
    mutationFn: (payload: {
      weights: Record<string, number>;
      thresholds: Record<string, [number, number]>;
      contributions: Record<string, number>;
    }) =>
      requestJson('/system/irsa/config', IrsaConfigResponse, {
        scope,
        method: 'POST',
        body: { json: { payload } },
      }),
    onSuccess: async () => {
      setNotice('Configuración guardada.');
      await client.invalidateQueries({ queryKey: ['indicators', scope] });
      await client.invalidateQueries({ queryKey: ['dashboard', scope] });
    },
  });
  return (
    <form
      className={styles.form}
      onSubmit={(event) => {
        event.preventDefault();
        if (save.isPending) return;
        setNotice('');
        const parsedWeights = Object.fromEntries(
          Object.entries(weights).map(([key, value]) => [
            key,
            value.trim() === '' ? NaN : Number(value),
          ]),
        );
        const parsedThresholds = Object.fromEntries(
          Object.entries(thresholds).map(([key, [low, high]]) => [
            key,
            [low.trim() === '' ? NaN : Number(low), high.trim() === '' ? NaN : Number(high)] as [
              number,
              number,
            ],
          ]),
        );
        const parsedContributions = Object.fromEntries(
          Object.entries(contributions).map(([key, value]) => [
            key,
            value.trim() === '' ? NaN : Number(value),
          ]),
        );
        const sum = dimensions.reduce((total, d) => total + (parsedWeights[d] ?? 0), 0);
        if (!Number.isFinite(sum) || Math.abs(sum - 1) > 0.02) {
          setValidation('Los pesos deben sumar aproximadamente 1.');
          return;
        }
        if (
          Object.values(parsedWeights).some((n) => !Number.isFinite(n) || n < 0) ||
          Object.values(parsedContributions).some((n) => !Number.isFinite(n)) ||
          Object.values(parsedThresholds).some(
            ([low, high]) => !Number.isFinite(low) || !Number.isFinite(high) || low > high,
          )
        ) {
          setValidation('Revise los valores numéricos y los límites de cada banda.');
          return;
        }
        setValidation('');
        save.mutate({
          weights: parsedWeights,
          thresholds: parsedThresholds,
          contributions: parsedContributions,
        });
      }}
    >
      <p>
        Los pesos deben sumar 1 (tolerancia 0,02). Los cambios afectan los cálculos futuros; los
        cortes existentes conservan su resultado.
      </p>
      <fieldset disabled={save.isPending}>
        <legend>Pesos de dimensiones</legend>
        <div className={styles.grid}>
          {dimensions.map((d) => (
            <Field
              key={d}
              label={`Peso ${d}`}
              type="number"
              step="any"
              min="0"
              required
              value={weights[d] ?? 0}
              onChange={(e) => setWeights({ ...weights, [d]: e.target.value })}
            />
          ))}
        </div>
      </fieldset>
      <fieldset disabled={save.isPending}>
        <legend>Bandas de riesgo</legend>
        <div className={styles.grid}>
          {Object.entries(thresholds).map(([name, band]) => (
            <div key={name}>
              <Field
                label={`Límite inferior ${name}`}
                type="number"
                step="any"
                required
                value={band[0]}
                onChange={(e) =>
                  setThresholds({ ...thresholds, [name]: [e.target.value, band[1]] })
                }
              />
              <Field
                label={`Límite superior ${name}`}
                type="number"
                step="any"
                required
                value={band[1]}
                onChange={(e) =>
                  setThresholds({ ...thresholds, [name]: [band[0], e.target.value] })
                }
              />
            </div>
          ))}
        </div>
      </fieldset>
      <fieldset disabled={save.isPending}>
        <legend>Contribuciones configuradas</legend>
        <div className={styles.grid}>
          {Object.entries(contributions).map(([name, value]) => (
            <Field
              key={name}
              label={`Contribución ${name}`}
              type="number"
              step="any"
              required
              value={value}
              onChange={(e) => setContributions({ ...contributions, [name]: e.target.value })}
            />
          ))}
        </div>
      </fieldset>
      {validation ? <Alert tone="error">{validation}</Alert> : null}
      {save.error ? <Alert tone="error">{errorDetail(save.error)}</Alert> : null}
      {notice ? <Alert tone="success">{notice}</Alert> : null}
      <Button type="submit" disabled={save.isPending}>
        {save.isPending ? 'Guardando configuración…' : 'Guardar configuración'}
      </Button>
    </form>
  );
};
