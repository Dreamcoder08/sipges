import { type ConflictRiskPrediction, ConflictRiskResponse } from '@sipges/contracts';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { requestJson } from '../../shared/api/client.ts';
import type { FeatureContext } from '../../shared/api/feature-context.ts';
import { InternalLink, objectHref } from '../../shared/lib/navigation.tsx';
import { Button } from '../../shared/ui/Button.tsx';
import { Card } from '../../shared/ui/Card.tsx';
import { QueryState } from '../../shared/ui/QueryState.tsx';
import { Limitations } from './ReportParts.tsx';
import styles from './ConflictRisk.module.css';

type Horizon = '30' | '90';
type Kind = 'locality' | 'actor';
type Backtest = ConflictRiskResponse['backtest'][Horizon];
type Source = ConflictRiskPrediction['factors'][number]['records'][number];

const BAND_LABEL = { alta: 'Riesgo alto', media: 'Riesgo medio', baja: 'Riesgo bajo' } as const;

/** Records open in their 360° view; territorial alerts live in Bandeja › Alertas. */
const RECORD_ROUTES: Readonly<Record<string, string>> = {
  Demandas: 'demandas',
  Compromisos: 'compromisos',
  Narrativas: 'narrativas',
  Alertas: 'alertas',
  Eventos: 'eventos',
};
const sourceHref = (source: Source) => {
  const module = RECORD_ROUTES[source.module];
  return module ? objectHref(module, source.id) : '/bandeja?vista=alertas';
};

/** Same decimal point as the IRSA card; at most `digits` decimals. */
const number = (value: number, digits = 2) =>
  String(Math.round(value * 10 ** digits) / 10 ** digits);
const percent = (value: number) => `${Math.round(value * 100)} %`;
/** A skill at or below zero is not an improvement; say so instead of «mejora −15 %». */
const skillText = (skill: number | null) =>
  skill !== null && skill > 0 ? `mejora ${percent(skill)}` : 'no supera la tasa base';

/** The locality the territorial map asked for (`?localidad=`), folded for matching. */
const fold = (value: string) =>
  value
    .normalize('NFD')
    .replace(/\p{Mn}/gu, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
const askedLocality = () => new URLSearchParams(window.location.search).get('localidad') ?? '';

const Toggle = <T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: readonly (readonly [T, string])[];
  onChange: (value: T) => void;
}) => (
  <div className={styles.toggle} role="group" aria-label={label}>
    {options.map(([option, text]) => (
      <button
        key={option}
        type="button"
        aria-pressed={value === option}
        className={value === option ? styles.on : undefined}
        onClick={() => onChange(option)}
      >
        {text}
      </button>
    ))}
  </div>
);

const UnitCard = ({ unit, horizon }: { unit: ConflictRiskPrediction; horizon: Horizon }) => {
  const prediction = unit.horizons[horizon];
  return (
    <article className={styles.unit}>
      <header className={styles.unitHeader}>
        <h4>{unit.name}</h4>
        <span className={`${styles.band} ${styles[prediction.band]}`}>
          {BAND_LABEL[prediction.band]}
        </span>
      </header>
      <p className={styles.probability}>
        {prediction.probability === null ? (
          <span className={styles.muted}>
            Sin porcentaje: el historial no alcanza para calibrar.
          </span>
        ) : (
          <>
            <strong>{percent(prediction.probability)}</strong> de escalar en {horizon} días
          </>
        )}
      </p>
      <p className={styles.muted}>
        Confianza {unit.confidence}. {unit.confidenceReason}
      </p>
      <h5 className={styles.factorsTitle}>En qué se basa</h5>
      <ul className={styles.factors}>
        {unit.factors.map((factor) => (
          <li key={factor.id}>
            <span>
              {factor.label}: <b>{number(factor.count, 1)}</b>{' '}
              <small className={styles.muted}>(aporta {number(factor.contribution)})</small>
            </span>
            {factor.records.length ? (
              <ul className={styles.sources}>
                {factor.records.map((source) => (
                  <li key={`${source.module}-${source.id}`}>
                    <InternalLink href={sourceHref(source)}>
                      {source.title} · {source.date}
                    </InternalLink>
                  </li>
                ))}
              </ul>
            ) : null}
          </li>
        ))}
      </ul>
    </article>
  );
};

const BacktestCard = ({ backtest }: { backtest: Backtest }) => {
  const samples = backtest.train.samples + backtest.test.samples;
  const events = backtest.train.events + backtest.test.events;
  return (
    <Card title={`Último back-test a ${backtest.horizon} días`}>
      {backtest.calibrated && backtest.brier !== null ? (
        <>
          <p>
            Brier {number(backtest.brier, 3)} frente a {number(backtest.brierReference ?? 0, 3)} de
            la tasa base ({skillText(backtest.skill)}). {samples} muestras y {events} escalamientos
            en {backtest.cutoffs} cortes, del {backtest.from} al {backtest.to}; se entrenó con los
            cortes más antiguos ({backtest.train.samples} muestras) y se evaluó con los más
            recientes ({backtest.test.samples}).
          </p>
          <div className={styles.tableWrap}>
            <table className={styles.bins}>
              <caption>Calibración: probabilidad predicha frente a lo observado</caption>
              <thead>
                <tr>
                  <th scope="col">Banda</th>
                  <th scope="col">Muestras</th>
                  <th scope="col">Predicha</th>
                  <th scope="col">Observada</th>
                </tr>
              </thead>
              <tbody>
                {backtest.bins.map((bin) => (
                  <tr key={bin.range}>
                    <th scope="row">{bin.range}</th>
                    <td>{bin.n}</td>
                    <td>{bin.predicted === null ? '—' : percent(bin.predicted)}</td>
                    <td>{bin.observed === null ? '—' : percent(bin.observed)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      ) : (
        <p>{backtest.reason}</p>
      )}
    </Card>
  );
};

/** Análisis › Riesgo de conflicto (docs/adr/0031): who is most likely to escalate, and why. */
export const ConflictRiskPage = (context: FeatureContext) => {
  const [horizon, setHorizon] = useState<Horizon>('90');
  const [kind, setKind] = useState<Kind>('locality');
  const [focus, setFocus] = useState(askedLocality);
  const query = useQuery({
    queryKey: ['analysis', context.scope, 'conflict-risk'],
    queryFn: ({ signal }) =>
      requestJson('/system/conflict-risk', ConflictRiskResponse, { scope: context.scope, signal }),
  });
  return (
    <div className={styles.page}>
      <p>
        Qué localidades y actores de {context.projectLabel} tienen más probabilidad de escalar en
        los próximos 30 o 90 días, según sus demandas, compromisos, narrativas, alertas e historial
        de IRSA. Se calcula dentro de SIPGES, sin IA externa; cada predicción muestra en qué se basa
        y cuán confiable es.
      </p>
      <div className={styles.controls}>
        <Toggle
          label="Horizonte"
          value={horizon}
          options={[
            ['30', '30 días'],
            ['90', '90 días'],
          ]}
          onChange={setHorizon}
        />
        <Toggle
          label="Unidad"
          value={kind}
          options={[
            ['locality', 'Localidades'],
            ['actor', 'Actores'],
          ]}
          onChange={setKind}
        />
        <Button
          variant="secondary"
          disabled={query.isFetching}
          onClick={() => void query.refetch()}
        >
          Actualizar
        </Button>
      </div>
      <QueryState query={query} label="el riesgo de conflicto">
        {(data) => {
          if (data.status === 'sin datos suficientes')
            return (
              <Card title="Sin datos suficientes">
                <p>
                  El proyecto aún no tiene demandas, compromisos, narrativas, alertas o eventos
                  fechados con localidad o actor. Sin ellos no hay predicción; la falta de registros
                  no demuestra ausencia de riesgo.
                </p>
              </Card>
            );
          const all = kind === 'locality' ? data.localities : data.actors;
          const focused =
            kind === 'locality' && focus ? all.filter((u) => fold(u.name) === fold(focus)) : all;
          return (
            <>
              {kind === 'locality' && focus ? (
                <p className={styles.focus}>
                  {focused.length
                    ? `Mostrando ${focus}.`
                    : `${focus} no tiene señales en los últimos 180 días.`}{' '}
                  <Button variant="ghost" onClick={() => setFocus('')}>
                    Ver todas
                  </Button>
                </p>
              ) : null}
              {focused.length ? (
                <div className={styles.units}>
                  {focused.map((unit) => (
                    <UnitCard key={unit.key} unit={unit} horizon={horizon} />
                  ))}
                </div>
              ) : focus && kind === 'locality' ? null : (
                <p className={styles.muted}>
                  Sin {kind === 'locality' ? 'localidades' : 'actores'} con señales recientes.
                </p>
              )}
              <BacktestCard backtest={data.backtest[horizon]} />
              <p className={styles.muted}>
                Generado: {data.generatedOn}. {data.method}
              </p>
              <Limitations items={data.limitations} />
            </>
          );
        }}
      </QueryState>
    </div>
  );
};
