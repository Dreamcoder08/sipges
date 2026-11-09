import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import type { FeatureContext } from '../../shared/api/feature-context.ts';
import { errorDetail } from '../../shared/api/feedback.ts';
import {
  raisedSituations,
  situationAlertsQuery,
  situationsReportQuery,
} from '../../shared/api/situations.ts';
import {
  reviewTerritorialAlert,
  territorialAlertsQuery,
} from '../../shared/api/territorial-alerts.ts';
import { InternalLink } from '../../shared/lib/navigation.tsx';
import { Alert } from '../../shared/ui/Alert.tsx';
import { Button } from '../../shared/ui/Button.tsx';
import { EmptyState } from '../../shared/ui/EmptyState.tsx';
import { Icon } from '../../shared/ui/Icon.tsx';
import styles from './DecisionInbox.module.css';
import {
  ageLabel,
  alertItems,
  groupItems,
  KIND_INFO,
  KINDS,
  orderItems,
  qualityItems,
  situationItems,
  type Kind,
  type PendingItem,
  type QualityReview,
  type UseQuality,
} from './model.ts';

const noQuality: UseQuality = () => ({ state: 'ready', observations: [] });

type Selection = { key: string; index: number };
type Decision = { id: string; status: string; note: string; verb: 'aprobada' | 'rechazada' };

const isTyping = (target: EventTarget | null) =>
  target instanceof HTMLElement &&
  target.closest('input, textarea, select, [contenteditable="true"], [role="dialog"]') !== null;
const isControl = (target: EventTarget | null) =>
  target instanceof HTMLElement && target.closest('button, a, summary') !== null;

/**
 * «Pendientes»: everything of the active project that awaits a decision, from the queries the
 * alert, quality and situation screens already use. Alerts are decided here with the
 * same review call as Inteligencia de redes; the server keeps the four-eyes rule (409), the UI
 * only declines to offer an approval it knows will be refused. Other kinds link to their screen.
 */
export const DecisionInbox = ({
  scope,
  role,
  username,
  useQuality = noQuality,
}: FeatureContext & { useQuality?: UseQuality }) => {
  const client = useQueryClient();
  const ids = useId();
  const writable = role !== 'consulta';
  const alerts = useQuery(territorialAlertsQuery(scope));
  const report = useQuery(situationsReportQuery(scope));
  const raised = useQuery(situationAlertsQuery(scope));
  const quality: QualityReview = useQuality(scope);
  const [now] = useState(() => Date.now());
  const [kind, setKind] = useState<Kind | 'todo'>('todo');
  const [selection, setSelection] = useState<Selection>({ key: '', index: 0 });
  const [open, setOpen] = useState(false);
  const [rejecting, setRejecting] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const [reasonMissing, setReasonMissing] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const reasonRef = useRef<HTMLTextAreaElement>(null);

  const decide = useMutation({
    mutationFn: ({ id, status, note }: Decision) =>
      reviewTerritorialAlert(scope, id, { status, reviewer_note: note }),
    onSuccess: async (result, { id, verb }) => {
      setNotice(
        result.second_validation_required
          ? `Primera validación de ${id} registrada: otra persona debe confirmarla.`
          : `${id} ${verb}.`,
      );
      setRejecting(null);
      await client.invalidateQueries({ queryKey: ['operations', scope] });
    },
  });

  const sources = [
    {
      label: 'las alertas',
      pending: alerts.isPending,
      failed: alerts.isError,
      retry: () => void alerts.refetch(),
    },
    {
      label: 'las situaciones',
      pending: report.isPending || raised.isPending,
      failed: report.isError || raised.isError,
      retry: () => void Promise.all([report.refetch(), raised.refetch()]),
    },
    {
      label: 'la revisión de calidad de datos',
      pending: quality.state === 'loading',
      failed: quality.state === 'error',
      retry: () => (quality.state === 'error' ? quality.retry() : undefined),
    },
  ];

  const all = orderItems([
    ...(alerts.data ? alertItems(alerts.data, username, writable) : []),
    ...(report.data && raised.data
      ? situationItems(report.data, new Set(raisedSituations(raised.data).keys()))
      : []),
    ...(quality.state === 'ready' ? qualityItems(quality.observations) : []),
  ]);
  const visible = kind === 'todo' ? all : all.filter((item) => item.kind === kind);
  const current =
    visible.find((item) => item.key === selection.key) ??
    visible[Math.min(selection.index, visible.length - 1)];
  const canDecide = current?.kind === 'alerta' && current.fourEyes.canDecide;
  const loading = sources.some((source) => source.pending);
  const failed = sources.filter((source) => source.failed);

  const select = (item: PendingItem | undefined) => {
    if (!item) return;
    setSelection({ key: item.key, index: visible.indexOf(item) });
    setRejecting(null);
  };
  const move = (delta: number) => {
    const at = current ? visible.indexOf(current) : -1;
    select(visible[Math.max(0, Math.min(visible.length - 1, at + delta))]);
  };
  const approve = () => {
    if (current?.kind !== 'alerta' || !current.fourEyes.canDecide || decide.isPending) return;
    setNotice(null);
    decide.mutate({
      id: current.ref,
      status: 'Corroborado',
      note: current.alert.reviewer_note ?? '',
      verb: 'aprobada',
    });
  };
  const startReject = () => {
    if (current?.kind !== 'alerta' || !current.fourEyes.canDecide || decide.isPending) return;
    setNotice(null);
    decide.reset();
    setReason('');
    setReasonMissing(false);
    setRejecting(current.key);
  };
  const submitReject = (event: FormEvent) => {
    event.preventDefault();
    if (current?.kind !== 'alerta' || decide.isPending) return;
    if (!reason.trim()) {
      setReasonMissing(true);
      reasonRef.current?.focus();
      return;
    }
    decide.mutate({
      id: current.ref,
      status: 'Descartado',
      note: reason.trim(),
      verb: 'rechazada',
    });
  };
  const closeDetail = () => {
    setOpen(false);
    setRejecting(null);
    listRef.current?.focus();
  };

  useEffect(() => {
    if (rejecting) reasonRef.current?.focus();
  }, [rejecting]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey) return;
      if (isTyping(event.target)) return;
      const key = event.key.length === 1 ? event.key.toLowerCase() : event.key;
      const onList = event.target === listRef.current;
      if (key === 'j' || (key === 'ArrowDown' && onList)) move(1);
      else if (key === 'k' || (key === 'ArrowUp' && onList)) move(-1);
      else if (key === 'a' && canDecide) approve();
      else if (key === 'r' && canDecide) startReject();
      else if (key === 'Enter' && !isControl(event.target) && current) {
        setOpen(true);
        headingRef.current?.focus();
      } else if (key === 'Escape' && (open || rejecting)) closeDetail();
      else return;
      event.preventDefault();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  });

  const groups = groupItems(visible);
  const countOf = (value: Kind | 'todo') =>
    value === 'todo' ? all.length : all.filter((item) => item.kind === value).length;
  const optionId = (item: PendingItem) => `${ids}-${visible.indexOf(item)}`;

  return (
    <div className={styles.page}>
      <div className={styles.top}>
        <label className={styles.filter}>
          Filtrar pendientes
          <select
            value={kind}
            onChange={(event) => {
              setKind(event.target.value as Kind | 'todo');
              setSelection({ key: '', index: 0 });
              setRejecting(null);
            }}
          >
            {[{ value: 'todo' as const, plural: 'Todo' }, ...KINDS].map((option) => (
              <option key={option.value} value={option.value}>
                {option.plural} ({countOf(option.value)})
              </option>
            ))}
          </select>
        </label>
        <p className={styles.keys} aria-label="Atajos de teclado">
          <span>
            <kbd>J</kbd> <kbd>K</kbd> moverse
          </span>
          <span>
            <kbd>Enter</kbd> abrir
          </span>
          <span>
            <kbd>Esc</kbd> cerrar
          </span>
          {canDecide ? (
            <>
              <span>
                <kbd>A</kbd> aprobar
              </span>
              <span>
                <kbd>R</kbd> rechazar
              </span>
            </>
          ) : null}
        </p>
      </div>
      <div className={styles.notices}>
        {failed.map((source) => (
          <div key={source.label} className={styles.sourceError}>
            <Alert tone="error">
              No se pudo cargar {source.label}. Los pendientes de abajo no la incluyen.
            </Alert>
            <Button variant="secondary" size="sm" onClick={source.retry}>
              Reintentar {source.label}
            </Button>
          </div>
        ))}
        {notice ? <Alert tone="success">{notice}</Alert> : null}
        {decide.error ? <Alert tone="error">{errorDetail(decide.error)}</Alert> : null}
      </div>
      <div className={styles.inbox} data-open={open}>
        <section className={styles.list} aria-label="Pendientes">
          <div
            ref={listRef}
            className={styles.listbox}
            role="listbox"
            aria-label="Pendientes de decisión"
            tabIndex={0}
            {...(current ? { 'aria-activedescendant': optionId(current) } : {})}
          >
            {groups.map((group) => (
              <div key={group.value} className={styles.group} role="group" aria-label={group.label}>
                <p className={styles.groupLabel} aria-hidden="true">
                  {group.label} · {group.items.length}
                </p>
                {group.items.map((item) => (
                  <Option
                    key={item.key}
                    id={optionId(item)}
                    item={item}
                    now={now}
                    selected={item === current}
                    onChoose={() => {
                      select(item);
                      setOpen(true);
                      listRef.current?.focus();
                    }}
                  />
                ))}
              </div>
            ))}
          </div>
          {!visible.length && loading ? <p role="status">Cargando pendientes…</p> : null}
          {!visible.length && !loading && !failed.length ? (
            <EmptyState
              title={
                kind === 'todo'
                  ? 'Nada pendiente. Bandeja al día.'
                  : 'Nada pendiente en esta categoría.'
              }
              icon="inbox"
            />
          ) : null}
        </section>
        <section className={styles.detail} aria-label="Detalle del pendiente" aria-live="polite">
          <Button variant="secondary" size="sm" className={styles.back} onClick={closeDetail}>
            Volver a la lista
          </Button>
          {current ? (
            <Detail
              item={current}
              headingRef={headingRef}
              busy={decide.isPending}
              rejecting={rejecting === current.key}
              reason={reason}
              reasonMissing={reasonMissing}
              reasonRef={reasonRef}
              onReason={setReason}
              onApprove={approve}
              onStartReject={startReject}
              onSubmitReject={submitReject}
              onCancelReject={() => {
                setRejecting(null);
                listRef.current?.focus();
              }}
            />
          ) : (
            <p className={styles.muted}>Selecciona un pendiente de la lista.</p>
          )}
        </section>
      </div>
    </div>
  );
};

const Option = ({
  id,
  item,
  now,
  selected,
  onChoose,
}: {
  id: string;
  item: PendingItem;
  now: number;
  selected: boolean;
  onChoose: () => void;
}) => {
  const kind = KIND_INFO[item.kind];
  const age = ageLabel(item.since, now);
  const pill =
    item.kind === 'alerta' && item.fourEyes.required
      ? item.fourEyes.firstValidator
        ? item.fourEyes.canDecide
          ? 'Falta confirmar'
          : 'Primera validación tuya'
        : 'Cuatro ojos'
      : null;
  return (
    // The listbox owns focus and keyboard; clicking is the pointer way to choose an option.
    <div id={id} role="option" aria-selected={selected} className={styles.item} onClick={onChoose}>
      <Icon name={kind.icon} />
      <span className={styles.title}>{item.title}</span>
      <span className={styles.age}>{age ?? ''}</span>
      <span className={styles.meta}>
        <span>{kind.singular}</span>
        <span>
          {item.ref}
          {item.where ? ` · ${item.where}` : ''}
        </span>
        {pill ? (
          <span
            className={`${styles.pill} ${pill === 'Primera validación tuya' ? styles.pillMine : ''}`}
          >
            {pill}
          </span>
        ) : null}
      </span>
    </div>
  );
};

const Detail = ({
  item,
  headingRef,
  busy,
  rejecting,
  reason,
  reasonMissing,
  reasonRef,
  onReason,
  onApprove,
  onStartReject,
  onSubmitReject,
  onCancelReject,
}: {
  item: PendingItem;
  headingRef: React.RefObject<HTMLHeadingElement | null>;
  busy: boolean;
  rejecting: boolean;
  reason: string;
  reasonMissing: boolean;
  reasonRef: React.RefObject<HTMLTextAreaElement | null>;
  onReason: (value: string) => void;
  onApprove: () => void;
  onStartReject: () => void;
  onSubmitReject: (event: FormEvent) => void;
  onCancelReject: () => void;
}) => {
  const kind = KIND_INFO[item.kind];
  return (
    <>
      <div className={styles.kind}>
        <Icon name={kind.icon} />
        <span>{kind.singular}</span>
        <span className={styles.ref}>
          {item.ref}
          {item.where ? ` · ${item.where}` : ''}
        </span>
      </div>
      <h2 ref={headingRef} tabIndex={-1}>
        {item.title}
      </h2>
      <p>{item.summary}</p>
      {item.facts.length ? (
        <section>
          <h3>Detalle</h3>
          <ul className={styles.bullets}>
            {item.facts.map((fact) => (
              <li key={fact}>{fact}</li>
            ))}
          </ul>
        </section>
      ) : null}
      {item.evidence.length ? (
        <section>
          <h3>Evidencia</h3>
          <ul className={styles.bullets}>
            {item.evidence.map((link) => (
              <li key={link.href}>
                <InternalLink href={link.href}>{link.label}</InternalLink>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      {item.kind === 'alerta' ? (
        <section className={styles.fourEyes} aria-labelledby={`${item.key}-rule`}>
          <h3 id={`${item.key}-rule`}>
            {item.fourEyes.required ? 'Regla de cuatro ojos' : 'Regla aplicable'}
          </h3>
          {item.fourEyes.required ? (
            <dl className={styles.facts}>
              <dt>Primera validación</dt>
              <dd>{item.fourEyes.firstValidator ?? 'Pendiente'}</dd>
              <dt>Confirmación</dt>
              <dd>Otra persona distinta</dd>
            </dl>
          ) : null}
          <p>{item.fourEyes.text}</p>
        </section>
      ) : null}
      {item.kind === 'alerta' && item.fourEyes.canDecide ? (
        <>
          <div className={styles.actions}>
            <Button disabled={busy} onClick={onApprove} aria-keyshortcuts="a">
              <Icon name="check" />
              Aprobar
              <kbd>A</kbd>
            </Button>
            <Button variant="danger" disabled={busy} onClick={onStartReject} aria-keyshortcuts="r">
              Rechazar
              <kbd>R</kbd>
            </Button>
          </div>
          {rejecting ? (
            <form className={styles.reject} onSubmit={onSubmitReject} noValidate>
              <label htmlFor={`${item.key}-reason`}>
                Motivo del rechazo (obligatorio, queda en la auditoría)
              </label>
              <textarea
                id={`${item.key}-reason`}
                ref={reasonRef}
                rows={3}
                maxLength={2000}
                value={reason}
                onChange={(event) => onReason(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Escape') {
                    event.preventDefault();
                    onCancelReject();
                  }
                }}
              />
              {reasonMissing ? (
                <p className={styles.error} role="alert">
                  Escribe el motivo para rechazar.
                </p>
              ) : null}
              <div className={styles.actions}>
                <Button type="submit" variant="danger" disabled={busy}>
                  Confirmar rechazo
                </Button>
                <Button variant="secondary" onClick={onCancelReject}>
                  Cancelar
                </Button>
              </div>
            </form>
          ) : null}
        </>
      ) : null}
      <p>
        <InternalLink href={item.owner.href}>{item.owner.label}</InternalLink>
      </p>
    </>
  );
};
