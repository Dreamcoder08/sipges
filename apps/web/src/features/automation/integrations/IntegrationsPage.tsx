import { useQuery } from '@tanstack/react-query';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import type { FeatureContext } from '../../../shared/api/feature-context.ts';
import {
  authorizedSourcesQuery,
  geographyCatalogueQuery,
  mediaFeedsQuery,
  pushConfigQuery,
} from '../../../shared/api/integrations.ts';
import { InternalLink } from '../../../shared/lib/navigation.tsx';
import { StatusBadge, type StatusTone } from '../../../shared/ui/Badges.tsx';
import { Alert } from '../../../shared/ui/Alert.tsx';
import { Icon } from '../../../shared/ui/Icon.tsx';
import type { IconName } from '../../../shared/ui/icons.ts';
import { apiKeysQuery, overviewQuery, runtimeQuery } from '../api.ts';
import { ApiKeysCard } from '../ApiKeysCard.tsx';
import { AutomationPage } from '../AutomationPage.tsx';
import { RuntimeCard } from '../RuntimeCard.tsx';
import {
  type Entry,
  FILTERS,
  type Filter,
  KIND_LABELS,
  type Panel,
  SECTIONS,
  SYNTHETIC_WARNING,
  TRUST_LABELS,
  buildCatalog,
  statusLabel,
} from './catalog.ts';
import styles from './IntegrationsPage.module.css';

const KIND_ICONS: Record<Entry['kind'], IconName> = {
  connector: 'plug',
  skill: 'bookOpen',
  scheduled: 'clock',
};

const CORE_RULES =
  'El aislamiento por proyecto, la auditoría de cada cambio, la aprobación a cuatro ojos y la verificación A–E se aplican en SIPGES; ninguna integración puede omitirlos.';

const MCP_POLICY =
  'Antes de enviar datos reales de AMSAC a un modelo externo, el titular debe registrar una decisión de tratamiento de datos bajo la Ley 29733: consentimiento, alcance y anonimización. Mientras tanto, solo debe usarse con los datos sintéticos de demostración.';

/** Accent-insensitive, case-insensitive form used to compare search text. */
const normalize = (text: string) =>
  text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();

const typeLabel = (entry: Entry) =>
  `${KIND_LABELS[entry.kind]}${entry.direction ? ` · ${entry.direction}` : ''}`;

const Trust = ({ entry }: { entry: Entry }) => (
  <span className={styles.trust} data-trust={entry.trust}>
    <Icon name={entry.trust === 'integrated' ? 'check' : 'sliders'} />
    {TRUST_LABELS[entry.trust]}
  </span>
);

const STATUS_TONES: Record<Entry['status'], StatusTone> = {
  ok: 'positive',
  pause: 'neutral',
  available: 'neutral',
  auth: 'warning',
  down: 'negative',
};

const Status = ({ entry }: { entry: Entry }) => (
  <StatusBadge tone={STATUS_TONES[entry.status]}>{statusLabel(entry)}</StatusBadge>
);

const actionName = (entry: Entry) =>
  entry.mine && entry.status === 'ok' && 'panel' in entry.open
    ? `${entry.action} ${entry.name}`
    : `${entry.action}: ${entry.name}`;

const Card = ({ entry, onOpen }: { entry: Entry; onOpen: (entry: Entry) => void }) => {
  const opener =
    'href' in entry.open ? (
      <InternalLink href={entry.open.href} className={styles.open}>
        {entry.name}
      </InternalLink>
    ) : (
      <button
        type="button"
        className={styles.open}
        data-open={entry.id}
        onClick={() => onOpen(entry)}
      >
        {entry.name}
      </button>
    );
  // Primary only where the next step is to authorize; everything else is a plain action.
  const actionClass = `${styles.action} ${entry.mine && entry.status === 'auth' ? styles.primary : ''}`;
  return (
    <li className={styles.card}>
      <div className={styles.cardTop}>
        <span className={styles.tile} aria-hidden="true">
          <Icon name={KIND_ICONS[entry.kind]} />
        </span>
        <div className={styles.cardName}>
          <h3>{opener}</h3>
          <small>
            {typeLabel(entry)}
            {entry.note ? (
              <>
                {' · '}
                <span>{entry.note}</span>
              </>
            ) : null}
          </small>
        </div>
        <Trust entry={entry} />
      </div>
      <div className={styles.cardBody}>
        <p>{entry.description}</p>
        {entry.warning ? (
          <div className={styles.warn}>
            <Icon name="alert" />
            <span>{entry.warning}</span>
          </div>
        ) : null}
      </div>
      <div className={styles.cardFoot}>
        <Status entry={entry} />
        {'href' in entry.open ? (
          <InternalLink
            href={entry.open.href}
            className={actionClass}
            aria-label={actionName(entry)}
          >
            {entry.action}
          </InternalLink>
        ) : (
          <button
            type="button"
            className={actionClass}
            aria-label={actionName(entry)}
            onClick={() => onOpen(entry)}
          >
            {entry.action}
          </button>
        )}
      </div>
    </li>
  );
};

const Detail = ({
  entry,
  context,
  renderSource,
  onBack,
}: {
  entry: Entry;
  context: FeatureContext;
  renderSource: ((source: 'defensoria' | 'media') => ReactNode) | undefined;
  onBack: () => void;
}) => {
  const title = useRef<HTMLHeadingElement>(null);
  useEffect(() => title.current?.focus(), []);
  const { scope } = context;
  const panels: Record<Panel, ReactNode> = {
    rules: <AutomationPage {...context} section="rules" />,
    channels: <AutomationPage {...context} section="channels" />,
    keys: <ApiKeysCard scope={scope} />,
    runtime: <RuntimeCard scope={scope} />,
    defensoria: renderSource?.('defensoria') ?? null,
    media: renderSource?.('media') ?? null,
    info: (
      <p className={styles.muted}>
        Cada persona activa los avisos de su dispositivo en Configuración › Notificaciones.
      </p>
    ),
  };
  const panel = 'panel' in entry.open ? entry.open.panel : 'info';
  return (
    <div className={styles.integ}>
      <button type="button" className={styles.back} onClick={onBack}>
        <Icon name="chevronLeft" />
        Integraciones
      </button>
      <div className={styles.detailHead}>
        <span className={`${styles.tile} ${styles.tileLarge}`} aria-hidden="true">
          <Icon name={KIND_ICONS[entry.kind]} />
        </span>
        <div>
          <h2 ref={title} tabIndex={-1}>
            {entry.name}
          </h2>
          <div className={styles.meta}>
            <span className={styles.muted}>{typeLabel(entry)}</span>
            <Trust entry={entry} />
            <Status entry={entry} />
          </div>
        </div>
      </div>
      {entry.warning ? (
        <div className={styles.alertbox} role="note">
          <Icon name="alert" />
          <div>
            <b>{SYNTHETIC_WARNING}.</b> <span>{MCP_POLICY}</span>
          </div>
        </div>
      ) : null}
      <div className={styles.panels}>
        <section className={styles.panel}>
          <h3>Qué hace</h3>
          <p>{entry.description}</p>
          <dl>
            <dt>Tipo</dt>
            <dd>{typeLabel(entry)}</dd>
            <dt>Alcance</dt>
            <dd>{context.projectLabel || context.scope}</dd>
          </dl>
        </section>
        <section className={`${styles.panel} ${styles.core}`}>
          <h3>Reglas que no se pueden saltar</h3>
          <p>{CORE_RULES}</p>
        </section>
      </div>
      {panels[panel]}
    </div>
  );
};

/**
 * One page for everything that connects SIPGES with other systems (odd/tasks/workspace-
 * architecture.md S4): inbound and outbound connectors, the analysis capabilities and the
 * scheduled rules, as cards over data the project already has. A card opens the management UI
 * that exists today; the integrity rules stay in the core (S6) and external models only see
 * synthetic data until the data-processing decision exists (S7).
 */
export const IntegrationsPage = ({
  renderSource,
  ...context
}: FeatureContext & {
  /** Management UI of sources that live in other features, composed by the app shell. */
  renderSource?: (source: 'defensoria' | 'media') => ReactNode;
}) => {
  const { scope, role } = context;
  const admin = role === 'admin';
  const enabled = { enabled: admin };
  const overview = useQuery({ ...overviewQuery(scope), ...enabled });
  const media = useQuery({ ...mediaFeedsQuery(scope), ...enabled });
  const defensoria = useQuery({ ...authorizedSourcesQuery(scope), ...enabled });
  const geography = useQuery({ ...geographyCatalogueQuery(scope), ...enabled });
  const keys = useQuery({ ...apiKeysQuery(scope), ...enabled });
  const runtime = useQuery({ ...runtimeQuery(scope), ...enabled });
  const push = useQuery({ ...pushConfigQuery(scope), ...enabled });
  const [mine, setMine] = useState(true);
  const [filter, setFilter] = useState<Filter>('all');
  const [search, setSearch] = useState('');
  const [openId, setOpenId] = useState<string | null>(null);
  const list = useRef<HTMLDivElement>(null);
  const returnTo = useRef<string | null>(null);

  useEffect(() => {
    if (openId !== null || returnTo.current === null) return;
    list.current?.querySelector<HTMLElement>(`[data-open="${returnTo.current}"]`)?.focus();
    returnTo.current = null;
  }, [openId]);

  if (!admin)
    return <Alert tone="info">Las integraciones solo las configura el rol administrador.</Alert>;

  const entries = buildCatalog({
    overview: overview.data,
    media: media.data,
    defensoria: defensoria.data,
    geography: geography.data,
    keys: keys.data,
    runtime: runtime.data,
    push: push.data,
  });
  const failed = (
    [
      [overview, 'Reglas y canales'],
      [media, 'Medios RSS'],
      [defensoria, 'Defensoría del Pueblo'],
      [geography, 'GEOCATMIN INGEMMET'],
      [keys, 'Claves de API'],
      [runtime, 'Procesamiento de reglas'],
      [push, 'Notificaciones push'],
    ] as const
  )
    .filter(([query]) => query.isError)
    .map(([, name]) => name);
  const pending = [overview, media, defensoria, geography, keys, runtime, push].some(
    (query) => query.isPending,
  );

  const opened = openId === null ? undefined : entries.find((entry) => entry.id === openId);
  if (opened)
    return (
      <Detail
        entry={opened}
        context={context}
        renderSource={renderSource}
        onBack={() => {
          returnTo.current = opened.id;
          setOpenId(null);
        }}
      />
    );

  const inScope = entries.filter((entry) => entry.mine === mine);
  const needle = normalize(search.trim());
  const shown = inScope.filter(
    (entry) =>
      (filter === 'all' || entry.kind === filter) &&
      (!needle ||
        normalize(`${entry.name} ${entry.description} ${KIND_LABELS[entry.kind]}`).includes(
          needle,
        )),
  );

  return (
    <div className={styles.integ} ref={list}>
      <p className={styles.lede}>
        Conecta fuentes, abre las capacidades de análisis y programa tareas. Las reglas de
        integridad (aislamiento por proyecto, auditoría, cuatro ojos y verificación A–E) viven en
        SIPGES: ninguna integración puede saltárselas.
      </p>
      <div className={styles.tools}>
        <div className={styles.toolsStart}>
          <div className={styles.seg} role="group" aria-label="Alcance">
            <button type="button" aria-pressed={mine} onClick={() => setMine(true)}>
              Tuyos
            </button>
            <button type="button" aria-pressed={!mine} onClick={() => setMine(false)}>
              Descubrir
            </button>
          </div>
          <label className={styles.search}>
            <Icon name="search" />
            <input
              type="search"
              aria-label="Buscar integraciones"
              placeholder="Buscar integraciones"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
          </label>
        </div>
        <div className={styles.chips} role="group" aria-label="Filtrar por tipo">
          {FILTERS.map((item) => (
            <button
              key={item.value}
              type="button"
              className={styles.chip}
              aria-pressed={filter === item.value}
              onClick={() => setFilter(item.value)}
            >
              <span>{item.label}</span>{' '}
              <span className={styles.count}>
                {
                  inScope.filter((entry) => item.value === 'all' || entry.kind === item.value)
                    .length
                }
              </span>
            </button>
          ))}
        </div>
      </div>
      {failed.length > 0 ? (
        <Alert tone="error">
          No se pudo consultar: {failed.join(', ')}. Las demás integraciones siguen disponibles.
        </Alert>
      ) : null}
      {SECTIONS.map((section) => {
        const items = shown.filter(
          (entry) =>
            entry.kind === section.kind &&
            (!('direction' in section) || entry.direction === section.direction),
        );
        if (items.length === 0) return null;
        return (
          <section key={section.title} className={styles.section}>
            <h2>
              {section.title}
              <small>{section.sub}</small>
            </h2>
            <ul className={styles.cards}>
              {items.map((entry) => (
                <Card key={entry.id} entry={entry} onOpen={(item) => setOpenId(item.id)} />
              ))}
            </ul>
          </section>
        );
      })}
      {shown.length === 0 ? (
        <p className={styles.empty} role={pending ? 'status' : undefined}>
          {pending ? 'Cargando integraciones…' : 'Nada para mostrar con este filtro.'}
        </p>
      ) : null}
    </div>
  );
};
