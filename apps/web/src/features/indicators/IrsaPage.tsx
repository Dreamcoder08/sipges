import { IrsaConfigResponse, IrsaSnapshotResponse, type IrsaConfig } from '@sipges/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { requestJson } from '../../shared/api/client.ts';
import { errorDetail } from '../../shared/api/feedback.ts';
import type { FeatureContext } from '../../shared/api/feature-context.ts';
import { Alert } from '../../shared/ui/Alert.tsx';
import { Button } from '../../shared/ui/Button.tsx';
import { Card } from '../../shared/ui/Card.tsx';
import { Field } from '../../shared/ui/Field.tsx';
import { IrsaPendingBadge, isIrsaPending } from '../../shared/ui/IrsaPendingBadge.tsx';
import { useLevelLabel } from '../../shared/lib/project-settings.tsx';
import { DIMENSIONS, LEVELS, dimensionLabel } from '../../shared/lib/text.ts';
import {
  decimalInput,
  formatDateTime,
  formatFractions,
  formatIndex,
  formatNumber,
  formatPercent,
  formatShares,
  formatShortDay,
  parseDecimal,
} from '../../shared/lib/format.ts';
import { DateText } from '../../shared/ui/DateText.tsx';
import { QueryState } from '../../shared/ui/QueryState.tsx';
import { LineChart, RadarChart } from '../../shared/ui/charts/Charts.tsx';
import { configQuery, historyQuery, irsaQuery } from './api.ts';
import { IndicatorTable } from './IndicatorTable.tsx';
import { contributionLabel, irsaMethodLabel } from './labels.ts';
import styles from './Indicators.module.css';

const dimensions = DIMENSIONS;
/** The six weights as shares of 100 % in dimension order, so they add up on screen. */
const weightShares = (weights: Readonly<Record<string, number>>) =>
  formatShares(dimensions.map((d) => weights[d] ?? 0));
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
  const levelName = useLevelLabel();
  const withMeaning = (level: string) =>
    (LEVELS as readonly string[]).includes(level)
      ? levelName(level as (typeof LEVELS)[number], level)
      : level;
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
              {data.insufficient_data ? (
                <>
                  <p className={styles.score}>Sin datos suficientes</p>
                  <p>Carga registros del proyecto para calcular el IRSA.</p>
                </>
              ) : (
                <p className={styles.score}>
                  {formatIndex(data.irsa)} / 100 · {withMeaning(data.level)}
                </p>
              )}
              {isIrsaPending(config.data?.status) ? (
                <p>
                  <IrsaPendingBadge status={config.data?.status} />
                </p>
              ) : null}
              <div className={styles.split}>
                <div className={styles.radar}>
                  <RadarChart
                    caption="Puntuación IRSA por dimensión (0 a 100)"
                    data={dimensions.map((d) => ({
                      key: d,
                      label: dimensionLabel(d),
                      value: data.scores[d],
                    }))}
                    renderLabel={(d) => d.key}
                  />
                  {/* The axes keep the letter; the names sit beside them here (functional-10 T3). */}
                  <ul className={styles.legend} aria-label="Dimensiones del gráfico">
                    {dimensions.map((d) => (
                      <li key={d}>{dimensionLabel(d)}</li>
                    ))}
                  </ul>
                </div>
                <div
                  className={styles.table}
                  tabIndex={0}
                  role="region"
                  aria-label="Puntuaciones por dimensión"
                >
                  <table>
                    <caption>
                      <span className={styles.captionText}>
                        Puntuación y disponibilidad por dimensión
                      </span>
                    </caption>
                    <thead>
                      <tr>
                        <th scope="col">Dimensión</th>
                        <th scope="col">Puntuación</th>
                        <th scope="col">Peso</th>
                        <th scope="col">Disponibilidad</th>
                      </tr>
                    </thead>
                    <tbody>
                      {dimensions.map((d, index) => (
                        <tr key={d}>
                          <th scope="row">{dimensionLabel(d)}</th>
                          <td>{formatIndex(data.scores[d])}</td>
                          <td>{weightShares(data.weights)[index]}</td>
                          <td>{formatPercent(data.availability[d])}</td>
                        </tr>
                      ))}
                      <tr>
                        <th scope="row">Total</th>
                        <td />
                        <td>
                          {formatPercent(
                            dimensions.reduce((sum, d) => sum + (data.weights[d] ?? 0), 0) * 100,
                          )}
                        </td>
                        <td />
                      </tr>
                    </tbody>
                  </table>
                </div>
              </div>
              {/* The badge above is the one caveat; how the index is computed waits here. */}
              <details>
                <summary>Cómo se calcula</summary>
                <p>{data.status}</p>
                <p>{irsaMethodLabel(data.config_version)}</p>
                {data.notes.map((note) => (
                  <p key={note}>{note}</p>
                ))}
                <p>
                  La disponibilidad mide cuántos indicadores son calculables; no representa
                  precisión científica.
                </p>
              </details>
              <details>
                <summary>Factores que explican el índice</summary>
                {data.drivers.length ? (
                  <ul>
                    {data.drivers.map((driver) => (
                      <li key={`${driver.dimension}/${driver.id}`}>
                        {driver.id} · {driver.label}: {formatIndex(driver.points)} puntos
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
              {rows.length > 0 &&
                (() => {
                  const latest = [...rows].sort((a, b) => b.ts.localeCompare(a.ts))[0];
                  return latest ? (
                    <p>
                      Último corte guardado: {formatIndex(latest.irsa)} / {latest.level} ·{' '}
                      {formatDateTime(latest.ts)}
                    </p>
                  ) : null;
                })()}
              <LineChart
                caption="Evolución del IRSA en los cortes guardados"
                empty="Guarde al menos dos cortes para ver la evolución del índice."
                data={[...rows]
                  .sort((a, b) => a.ts.localeCompare(b.ts))
                  .map((row) => ({
                    key: String(row.id),
                    label: formatShortDay(row.ts),
                    value: Math.round(row.irsa * 10) / 10,
                  }))}
              />
              <div className={styles.table} tabIndex={0} role="region" aria-label="Historial IRSA">
                <table>
                  <caption>
                    <span className={styles.captionText}>Últimos 50 cortes del proyecto</span>
                  </caption>
                  <thead>
                    <tr>
                      <th scope="col">Fecha</th>
                      <th scope="col">IRSA / nivel</th>
                      <th scope="col">Método IRSA</th>
                      <th scope="col">Nota</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((row) => (
                      <tr key={row.id}>
                        <td>
                          <DateText value={row.ts} time />
                        </td>
                        <td>
                          {formatIndex(row.irsa)} / {row.level}
                        </td>
                        <td>{irsaMethodLabel(row.config_version)}</td>
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
                <ul aria-label="Pesos de dimensiones">
                  {dimensions.map((d, index) => (
                    <li key={d}>
                      Peso {dimensionLabel(d)}: {weightShares(data.weights)[index]}
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

/**
 * A decimal field in Spanish: text with the decimal keypad, so it shows and accepts «0,167» (a
 * number input would show «0.167» and drop the comma); a point is still accepted.
 */
const DECIMAL_FIELD = {
  type: 'text',
  inputMode: 'decimal',
  autoComplete: 'off',
  spellCheck: false,
  required: true,
} as const;

const ConfigurationForm = ({ scope, config }: { scope: string; config: IrsaConfig }) => {
  // Weights show as fractions that add up (0,167 ×4 and 0,166 ×2, like the shares above); one the
  // person leaves as shown keeps its stored value, so an untouched save stores the same numbers.
  const shownWeights = Object.fromEntries(
    formatFractions(dimensions.map((d) => config.weights[d] ?? 0)).map((text, index) => [
      dimensions[index] as string,
      text,
    ]),
  );
  const initialWeights = Object.fromEntries(
    Object.entries(config.weights).map(([key, value]) => [
      key,
      shownWeights[key] ?? decimalInput(value),
    ]),
  );
  const [weights, setWeights] = useState(initialWeights);
  const [thresholds, setThresholds] = useState<Record<string, [string, string]>>(
    Object.fromEntries(
      Object.entries(config.thresholds).map(([key, [low, high]]) => [
        key,
        [decimalInput(low), decimalInput(high)],
      ]),
    ),
  );
  const [contributions, setContributions] = useState(
    Object.fromEntries(
      Object.entries(config.contributions).map(([key, value]) => [key, decimalInput(value)]),
    ),
  );
  const weightValue = (key: string, text: string) =>
    text === initialWeights[key] ? (config.weights[key] ?? NaN) : parseDecimal(text);
  const weightSum = dimensions.reduce((total, d) => total + weightValue(d, weights[d] ?? ''), 0);
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
          Object.entries(weights).map(([key, value]) => [key, weightValue(key, value)]),
        );
        const parsedThresholds = Object.fromEntries(
          Object.entries(thresholds).map(([key, [low, high]]) => [
            key,
            [parseDecimal(low), parseDecimal(high)] as [number, number],
          ]),
        );
        const parsedContributions = Object.fromEntries(
          Object.entries(contributions).map(([key, value]) => [key, parseDecimal(value)]),
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
              label={`Peso ${dimensionLabel(d)}`}
              {...DECIMAL_FIELD}
              value={weights[d] ?? 0}
              onChange={(e) => setWeights({ ...weights, [d]: e.target.value })}
            />
          ))}
        </div>
        <p className={styles.hint} aria-live="polite">
          Suma de los pesos:{' '}
          {Number.isFinite(weightSum) ? formatNumber(weightSum, 3) : 'revise los valores'}
        </p>
      </fieldset>
      <fieldset disabled={save.isPending}>
        <legend>Bandas de riesgo</legend>
        <div className={styles.grid}>
          {Object.entries(thresholds).map(([name, band]) => (
            <div key={name}>
              <Field
                label={`Límite inferior ${name}`}
                {...DECIMAL_FIELD}
                value={band[0]}
                onChange={(e) =>
                  setThresholds({ ...thresholds, [name]: [e.target.value, band[1]] })
                }
              />
              <Field
                label={`Límite superior ${name}`}
                {...DECIMAL_FIELD}
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
        <legend>Contribuciones del prototipo</legend>
        <p className={styles.hint}>
          No intervienen en el cálculo del IRSA V0.4, que usa solo los 32 indicadores. Se conservan
          para comparar con el prototipo SIPGES.
        </p>
        <div className={styles.grid}>
          {Object.entries(contributions).map(([name, value]) => (
            <Field
              key={name}
              label={contributionLabel(name)}
              {...DECIMAL_FIELD}
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
