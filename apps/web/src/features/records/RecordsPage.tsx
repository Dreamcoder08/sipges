import { FollowupPanel } from './followup/FollowupPanel.tsx';
import type { ModuleRecord, Role } from '@sipges/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { ZodError } from 'zod';
import { isApiError } from '../../shared/api/client.ts';
import { Alert } from '../../shared/ui/Alert.tsx';
import { Button } from '../../shared/ui/Button.tsx';
import { Card } from '../../shared/ui/Card.tsx';
import { EmptyState } from '../../shared/ui/EmptyState.tsx';
import { InternalLink, objectHref } from '../../shared/lib/navigation.tsx';
import { Field } from '../../shared/ui/Field.tsx';
import { QueryState } from '../../shared/ui/QueryState.tsx';
import { deleteRecord, recordQuery, recordsQuery, saveRecord } from './api.ts';
import { EvidencePanel } from './EvidencePanel.tsx';
import { moduleAttachmentsQuery } from './evidence-api.ts';
import { HistoryPanel } from './HistoryPanel.tsx';
import { ImportPanel } from './ImportPanel.tsx';
import { LinksPanel } from './LinksPanel.tsx';
import { isPendingActorIdentity } from './insights/actor-identity.ts';
import { ActorMap } from './insights/ActorMap.tsx';
import { NarrativeTrend } from './NarrativeTrend.tsx';
import { ConfirmDelete } from './ConfirmDelete.tsx';
import { type ActiveFilter, ActiveFilters, FilterSheet } from './FilterSheet.tsx';
import { RecordDetail } from './RecordDetail.tsx';
import { RecordCell, isCompactCell } from './RecordCell.tsx';
import { RecordRows } from './hub/RecordRows.tsx';
import { summarize } from './hub/summary.ts';
import { RecordEditor } from './RecordEditor.tsx';
import { canWriteRecords, fieldValue } from './model.ts';
import { FACETS, MODULES, type RecordModule } from './modules.ts';
import styles from './Records.module.css';

type Props = {
  module: RecordModule;
  scope: string;
  projectId: string;
  projectLabel: string;
  role: Role;
  /**
   * When set, «Ver» hands the record to the caller (the Registros hub's sheet) instead of this
   * page's own panel, with the list it came from: under Demandas that may be `compromisos`.
   */
  onView?: (id: string, module: RecordModule) => void;
  /** Under Demandas, the sub-list to start on (the hub reopening a compromiso from the URL). */
  list?: RecordModule | undefined;
  /** Open with the new-record form or the CSV import already showing (the hub's «Nuevo registro» / «Importar»). */
  start?: 'create' | 'import' | undefined;
  /** With `onView`: two-line rows that open the hub's sheet instead of the table (below 1024 px). */
  twoLineRows?: boolean;
};
const message = (error: unknown) =>
  !error
    ? null
    : isApiError(error)
      ? error.detail
      : error instanceof ZodError
        ? 'Revise los datos. No se admiten caracteres nulos.'
        : error instanceof Error
          ? error.message
          : 'No se pudo completar la operación.';

export const RecordsPage = (props: Props) => {
  const [module, setModule] = useState<RecordModule>(
    props.module === 'demandas' && props.list === 'compromisos' ? 'compromisos' : props.module,
  );
  return (
    <div className={styles.page}>
      {props.module === 'demandas' ? (
        <div className={styles.actions} aria-label="Demandas y compromisos">
          <Button
            variant={module === 'demandas' ? 'primary' : 'secondary'}
            aria-pressed={module === 'demandas'}
            onClick={() => setModule('demandas')}
          >
            Demandas
          </Button>
          <Button
            variant={module === 'compromisos' ? 'primary' : 'secondary'}
            aria-pressed={module === 'compromisos'}
            onClick={() => setModule('compromisos')}
          >
            Compromisos
          </Button>
        </div>
      ) : null}
      <RecordsWorkspace key={`${props.scope}/${module}`} {...props} module={module} />
    </div>
  );
};

/** What the workspace shows in place of the list: one record, read or edited, or a new one. */
type Panel = { kind: 'list' } | { kind: 'create' } | { kind: 'view' | 'edit'; id: string };

const facetValue = (row: ModuleRecord, module: RecordModule, key: string) => {
  const field = MODULES[module].fields.find((item) => item.key === key);
  return field ? fieldValue(row, field).trim() : '';
};

const RecordsWorkspace = ({
  module,
  scope,
  projectId,
  projectLabel,
  role,
  onView,
  start,
  twoLineRows,
}: Props) => {
  const [pendingActors, setPendingActors] = useState(false);
  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');
  const [facets, setFacets] = useState<Record<string, string>>({});
  const [pageIndex, setPageIndex] = useState(0);
  const [panel, setPanel] = useState<Panel>(
    start === 'create' && canWriteRecords(role) ? { kind: 'create' } : { kind: 'list' },
  );
  const [deleting, setDeleting] = useState<string | null>(null);
  const [notice, setNotice] = useState('');
  const [uploadBusy, setUploadBusy] = useState(false);
  const [importing, setImporting] = useState(start === 'import');
  // Where focus returns when a record panel closes (the row's own «Ver»/«Editar» button).
  const returnTo = useRef<string | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const filtersButton = useRef<HTMLButtonElement>(null);
  const client = useQueryClient();
  const rows = useQuery(recordsQuery(module, scope, search));
  const selectedId = panel.kind === 'view' || panel.kind === 'edit' ? panel.id : '';
  const detail = useQuery({ ...recordQuery(module, scope, selectedId), enabled: !!selectedId });
  const definition = MODULES[module];
  const writable = canWriteRecords(role);
  // Sources are reports: the list says which ones have their file stored (error 05).
  const files = useQuery({
    ...moduleAttachmentsQuery(module, scope),
    enabled: module === 'fuentes',
  });
  const fileCount = (id: string) =>
    files.data?.filter((f) => f.linked_record_id === id).length ?? 0;
  useEffect(() => {
    if (panel.kind === 'list') {
      if (returnTo.current)
        [...document.querySelectorAll<HTMLElement>('[data-return]')]
          .find((element) => element.dataset.return === returnTo.current)
          ?.focus();
      returnTo.current = null;
      return;
    }
    heading.current?.focus();
    heading.current?.scrollIntoView?.({ block: 'start' });
  }, [panel]);
  const openPanel = (next: Panel, from?: string) => {
    returnTo.current = from ?? null;
    setPanel(next);
  };
  const closePanel = () => setPanel({ kind: 'list' });
  const refresh = () =>
    Promise.all([
      client.invalidateQueries({ queryKey: ['records'] }),
      client.invalidateQueries({ queryKey: ['dashboard'] }),
      client.invalidateQueries({ queryKey: ['indicators', scope] }),
      client.invalidateQueries({ queryKey: ['analysis', scope] }),
      client.invalidateQueries({ queryKey: ['operations', scope] }),
    ]);
  const save = useMutation({
    mutationFn: ({
      values,
      extras,
    }: {
      values: Record<string, string>;
      extras: Record<string, string>;
    }) =>
      saveRecord(
        module,
        scope,
        projectId,
        projectLabel,
        values,
        panel.kind === 'edit' ? panel.id : undefined,
        extras,
      ),
    onSuccess: async (id) => {
      setNotice(`Registro ${id} guardado. Usa «Ver» para revisar su ficha y adjuntar evidencias.`);
      setPanel({ kind: 'list' });
      await refresh();
    },
  });
  const remove = useMutation({
    mutationFn: (id: string) => deleteRecord(module, scope, id),
    onSuccess: async () => {
      setDeleting(null);
      setPanel({ kind: 'list' });
      setNotice('Registro eliminado.');
      await refresh();
    },
  });
  const busy = save.isPending || remove.isPending || uploadBusy;
  const moduleFacets = FACETS[module] ?? [];
  const setFacet = (key: string, value: string) => {
    setFacets((current) => ({ ...current, [key]: value }));
    setPageIndex(0);
  };
  const clearFacets = () => {
    setFacets({});
    setPageIndex(0);
  };
  const activeFacets: ActiveFilter[] = moduleFacets
    .filter(({ key }) => facets[key])
    .map(({ key, label }) => ({
      id: key,
      label: `${label}: ${facets[key]}`,
      remove: () => setFacet(key, ''),
    }));

  if (panel.kind !== 'list') {
    const title =
      panel.kind === 'create'
        ? `Nuevo registro · ${definition.label}`
        : `${panel.kind === 'edit' ? 'Editar' : 'Ficha'} ${panel.id}`;
    return (
      <>
        {notice ? <Alert tone="success">{notice}</Alert> : null}
        <section className={styles.panel} aria-labelledby="record-panel-title">
          <header className={styles.panelHeader}>
            <h3 id="record-panel-title" ref={heading} tabIndex={-1}>
              {title}
            </h3>
            <div className={styles.actions}>
              {panel.kind === 'view' && writable ? (
                <Button
                  variant="secondary"
                  disabled={busy}
                  onClick={() => {
                    save.reset();
                    setNotice('');
                    setPanel({ kind: 'edit', id: panel.id });
                  }}
                >
                  Editar
                </Button>
              ) : null}
              {panel.kind !== 'create' ? (
                <InternalLink href={objectHref(module, panel.id)}>Vista 360°</InternalLink>
              ) : null}
              <Button variant="ghost" disabled={busy} onClick={closePanel}>
                Volver a la lista
              </Button>
            </div>
          </header>
          {panel.kind === 'create' ? (
            <RecordEditor
              module={module}
              scope={scope}
              pending={save.isPending}
              error={message(save.error)}
              onSave={(values, extras) => save.mutate({ values, extras })}
              onCancel={closePanel}
            />
          ) : (
            <QueryState query={detail} label="la ficha">
              {(record) =>
                panel.kind === 'edit' && writable ? (
                  <RecordEditor
                    key={record._id}
                    module={module}
                    scope={scope}
                    record={record}
                    pending={save.isPending}
                    error={message(save.error)}
                    onSave={(values, extras) => save.mutate({ values, extras })}
                    onCancel={() => setPanel({ kind: 'view', id: panel.id })}
                  />
                ) : (
                  <>
                    <RecordDetail module={module} record={record} />
                    {module === 'demandas' ? (
                      <DemandCommitments scope={scope} id={record._id} />
                    ) : null}
                    <EvidencePanel
                      key={`${scope}/${module}/${record._id}`}
                      module={module}
                      id={record._id}
                      scope={scope}
                      writable={writable}
                      onBusyChange={setUploadBusy}
                    />
                    <LinksPanel
                      key={`links/${scope}/${module}/${record._id}`}
                      module={module}
                      id={record._id}
                      scope={scope}
                      writable={writable}
                    />
                    <HistoryPanel
                      key={`history/${scope}/${module}/${record._id}`}
                      module={module}
                      id={record._id}
                      scope={scope}
                    />
                  </>
                )
              }
            </QueryState>
          )}
          {detail.error ? (
            <div className={styles.actions}>
              <Button variant="secondary" onClick={() => void detail.refetch()}>
                Reintentar
              </Button>
            </div>
          ) : null}
        </section>
      </>
    );
  }

  return (
    <>
      {!writable ? (
        <Alert tone="info">
          Tu rol permite consultar estos registros. La edición y las cargas requieren permiso de
          escritura.
        </Alert>
      ) : null}
      {notice ? <Alert tone="success">{notice}</Alert> : null}
      {module === 'narrativas' ? <NarrativeTrend scope={scope} /> : null}
      <Card
        title={definition.label}
        action={
          writable ? (
            <div className={styles.actions}>
              <Button
                disabled={busy}
                onClick={() => {
                  save.reset();
                  setNotice('');
                  openPanel({ kind: 'create' });
                }}
              >
                Nuevo registro
              </Button>
              <Button
                variant="secondary"
                aria-expanded={importing}
                onClick={() => setImporting((open) => !open)}
              >
                Importar CSV
              </Button>
            </div>
          ) : undefined
        }
      >
        <form
          className={styles.search}
          onSubmit={(event) => {
            event.preventDefault();
            setSearch(searchInput.trim());
            setPageIndex(0);
          }}
        >
          <Field
            label="Buscar registros"
            value={searchInput}
            onChange={(event) => setSearchInput(event.target.value)}
            type="search"
          />
          <Button type="submit" variant="secondary">
            Buscar
          </Button>
        </form>
        <QueryState query={rows} label="los registros">
          {(data) => {
            const pendingCount =
              module === 'actores' ? data.filter(isPendingActorIdentity).length : 0;
            const identityRows =
              module === 'actores'
                ? data.filter((row) => isPendingActorIdentity(row) === pendingActors)
                : data;
            const visible = identityRows.filter((row) =>
              moduleFacets.every(
                ({ key }) => !facets[key] || facetValue(row, module, key) === facets[key],
              ),
            );
            const pageCount = Math.max(1, Math.ceil(visible.length / 50));
            const currentPage = Math.min(pageIndex, pageCount - 1);
            const pageRows = visible.slice(currentPage * 50, (currentPage + 1) * 50);
            const openInsight = (id: string, from?: string) =>
              onView
                ? onView(id, module)
                : openPanel({ kind: 'view', id }, from ?? `insight-${id}`);
            return (
              <>
                {module === 'acciones' || module === 'compromisos' ? (
                  <FollowupPanel rows={visible} module={module} onOpen={openInsight} />
                ) : null}
                {module === 'actores' ? (
                  <>
                    <div className={styles.actions} aria-label="Identidad de actores">
                      <Button
                        variant={!pendingActors ? 'primary' : 'secondary'}
                        aria-pressed={!pendingActors}
                        onClick={() => {
                          setPendingActors(false);
                          setPageIndex(0);
                        }}
                      >
                        Padrón con nombre ({data.length - pendingCount})
                      </Button>
                      <Button
                        variant={pendingActors ? 'primary' : 'secondary'}
                        aria-pressed={pendingActors}
                        onClick={() => {
                          setPendingActors(true);
                          setPageIndex(0);
                        }}
                      >
                        Menciones pendientes ({pendingCount})
                      </Button>
                    </div>
                    <p>
                      Un nombre registrado no implica identidad corroborada. Las menciones
                      pendientes conservan su extracto y fuente, pero no representan actores
                      identificados en el mapa.
                    </p>
                    {!pendingActors ? <ActorMap rows={visible} onOpen={openInsight} /> : null}
                  </>
                ) : null}
                {moduleFacets.length ? (
                  <div className={styles.filters}>
                    <FilterSheet
                      active={activeFacets}
                      shown={visible.length}
                      onClear={clearFacets}
                      buttonRef={filtersButton}
                    >
                      {moduleFacets.map(({ key, label }) => {
                        const options = [
                          ...new Set(data.map((row) => facetValue(row, module, key))),
                        ]
                          .filter(Boolean)
                          .sort((a, b) => a.localeCompare(b, 'es'));
                        return (
                          <div className={styles.field} key={key}>
                            <label htmlFor={`facet-${module}-${key}`}>{label}</label>
                            <select
                              id={`facet-${module}-${key}`}
                              value={facets[key] ?? ''}
                              onChange={(event) => setFacet(key, event.target.value)}
                            >
                              <option value="">Todos</option>
                              {options.map((option) => (
                                <option key={option} value={option}>
                                  {option}
                                </option>
                              ))}
                            </select>
                          </div>
                        );
                      })}
                    </FilterSheet>
                    <ActiveFilters
                      active={activeFacets}
                      onClear={clearFacets}
                      fallback={filtersButton}
                    />
                  </div>
                ) : null}
                <p className={styles.muted} role="status">
                  {pageRows.length} de {visible.length} registro(s) mostrados · {data.length} en la
                  consulta
                </p>
                {pageCount > 1 ? (
                  <nav aria-label="Paginación de registros" className={styles.actions}>
                    <Button
                      variant="secondary"
                      disabled={currentPage === 0}
                      onClick={() => setPageIndex(currentPage - 1)}
                    >
                      Página anterior
                    </Button>
                    <p aria-live="polite">
                      Página {currentPage + 1} de {pageCount}
                    </p>
                    <Button
                      variant="secondary"
                      disabled={currentPage + 1 >= pageCount}
                      onClick={() => setPageIndex(currentPage + 1)}
                    >
                      Página siguiente
                    </Button>
                  </nav>
                ) : null}
                {visible.length && twoLineRows && onView ? (
                  <RecordRows
                    rows={pageRows.map((row) => summarize(module, row))}
                    label={`Registros de ${definition.label.toLowerCase()} del proyecto activo`}
                    onOpen={({ id }) => onView(id, module)}
                  />
                ) : visible.length ? (
                  <div
                    className={styles.tableWrap}
                    tabIndex={0}
                    role="region"
                    aria-label={`Tabla de ${definition.label.toLowerCase()}`}
                  >
                    <table className={styles.table}>
                      <caption className="visually-hidden">
                        Registros de {definition.label.toLowerCase()} del proyecto activo
                      </caption>
                      <thead>
                        <tr>
                          {definition.columns.map((key) => {
                            const field = definition.fields.find((item) => item.key === key);
                            return (
                              <th
                                scope="col"
                                key={key}
                                className={
                                  isCompactCell(module, field ?? { key, label: key })
                                    ? styles.compact
                                    : undefined
                                }
                              >
                                {field?.label ?? key}
                              </th>
                            );
                          })}
                          {module === 'actores' && pendingActors ? (
                            <th scope="col">Extracto documental</th>
                          ) : null}
                          {module === 'fuentes' ? <th scope="col">Archivos</th> : null}
                          <th scope="col">Acciones</th>
                        </tr>
                      </thead>
                      <tbody>
                        {pageRows.map((row) => (
                          <tr key={row._id}>
                            {definition.columns.map((key) => {
                              const field = definition.fields.find((item) => item.key === key) ?? {
                                key,
                                label: key,
                              };
                              return (
                                <td
                                  key={key}
                                  data-label={field.label}
                                  className={
                                    isCompactCell(module, field) ? styles.compact : undefined
                                  }
                                >
                                  <RecordCell module={module} row={row} field={field} />
                                </td>
                              );
                            })}
                            {module === 'actores' && pendingActors ? (
                              <td>{String(row['Rol/Relacion'] || 'Sin extracto registrado')}</td>
                            ) : null}
                            {module === 'fuentes' ? (
                              <td data-label="Archivos">
                                {files.isPending
                                  ? '…'
                                  : files.isError
                                    ? 'No se pudieron consultar los archivos'
                                    : fileCount(row._id)
                                      ? `${fileCount(row._id)} archivo(s) · abrir con «Ver»`
                                      : 'Sin archivo almacenado'}
                              </td>
                            ) : null}
                            <td data-label="Acciones">
                              <div className={styles.rowActions}>
                                <Button
                                  variant="ghost"
                                  disabled={busy}
                                  aria-label={`Ver ${row._id}`}
                                  data-return={`ver-${row._id}`}
                                  onClick={() =>
                                    onView
                                      ? onView(row._id, module)
                                      : openPanel({ kind: 'view', id: row._id }, `ver-${row._id}`)
                                  }
                                >
                                  Ver
                                </Button>
                                {writable ? (
                                  <>
                                    <Button
                                      variant="ghost"
                                      disabled={busy}
                                      aria-label={`Editar ${row._id}`}
                                      data-return={`editar-${row._id}`}
                                      onClick={() => {
                                        save.reset();
                                        setNotice('');
                                        openPanel(
                                          { kind: 'edit', id: row._id },
                                          `editar-${row._id}`,
                                        );
                                      }}
                                    >
                                      Editar
                                    </Button>
                                    <Button
                                      variant="ghost"
                                      className={styles.deleteAction}
                                      disabled={busy}
                                      aria-label={`Eliminar ${row._id}`}
                                      onClick={() => {
                                        remove.reset();
                                        setDeleting(row._id);
                                      }}
                                    >
                                      Eliminar
                                    </Button>
                                  </>
                                ) : null}
                              </div>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : search || Object.values(facets).some(Boolean) ? (
                  <EmptyState
                    title="Sin registros para esta búsqueda."
                    action={
                      <Button
                        variant="secondary"
                        onClick={() => {
                          setSearchInput('');
                          setSearch('');
                          setFacets({});
                          setPageIndex(0);
                        }}
                      >
                        Limpiar búsqueda
                      </Button>
                    }
                  >
                    Prueba con otras palabras, otros filtros o revisa la ortografía.
                  </EmptyState>
                ) : (
                  <EmptyState title={`Aún no hay registros de ${definition.label.toLowerCase()}.`}>
                    {writable
                      ? 'Usa «Nuevo registro» o «Importar CSV» para cargar el primero en el proyecto activo.'
                      : 'Cuando el equipo registre información aparecerá aquí.'}
                  </EmptyState>
                )}
              </>
            );
          }}
        </QueryState>
        {rows.error ? (
          <Button variant="secondary" onClick={() => void rows.refetch()}>
            Reintentar
          </Button>
        ) : null}
      </Card>
      {importing && writable ? (
        <Card>
          <ImportPanel module={module} scope={scope} onClose={() => setImporting(false)} />
        </Card>
      ) : null}
      {deleting ? (
        <ConfirmDelete
          id={deleting}
          pending={remove.isPending}
          error={message(remove.error)}
          onCancel={() => setDeleting(null)}
          onConfirm={() => remove.mutate(deleting)}
        />
      ) : null}
    </>
  );
};

/** Commitments whose «Demanda asociada» is this demand: its follow-up, read from real data. */
const DemandCommitments = ({ scope, id }: { scope: string; id: string }) => {
  const commitments = useQuery(recordsQuery('compromisos', scope, ''));
  return (
    <section aria-labelledby={`commitments-${id}`}>
      <h4 id={`commitments-${id}`}>Compromisos de seguimiento</h4>
      <QueryState query={commitments} label="los compromisos">
        {(rows) => {
          const related = rows.filter((row) => String(row.Demanda_Asociada ?? '') === id);
          return related.length ? (
            <ul>
              {related.map((row) => (
                <li key={row._id}>
                  <InternalLink href={objectHref('compromisos', row._id)}>{row._id}</InternalLink>
                  {' · '}
                  {String(row.Descripcion ?? 'Sin descripción')} ·{' '}
                  {String(row.Estado ?? 'Sin estado')}
                  {row['Avance_%'] != null ? ` · ${String(row['Avance_%'])} %` : ''}
                </li>
              ))}
            </ul>
          ) : (
            <p className={styles.muted}>Ningún compromiso registrado cita esta demanda.</p>
          );
        }}
      </QueryState>
    </section>
  );
};
