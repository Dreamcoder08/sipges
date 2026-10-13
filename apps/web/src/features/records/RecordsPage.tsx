import type { Role } from '@mascli/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { ZodError } from 'zod';
import { isApiError } from '../../shared/api/client.ts';
import { Alert } from '../../shared/ui/Alert.tsx';
import { Button } from '../../shared/ui/Button.tsx';
import { Card } from '../../shared/ui/Card.tsx';
import { Field } from '../../shared/ui/Field.tsx';
import { QueryState } from '../../shared/ui/QueryState.tsx';
import { deleteRecord, recordQuery, recordsQuery, saveRecord } from './api.ts';
import { EvidencePanel } from './EvidencePanel.tsx';
import { ConfirmDelete } from './ConfirmDelete.tsx';
import { RecordDetail } from './RecordDetail.tsx';
import { RecordEditor } from './RecordEditor.tsx';
import { canWriteRecords, fieldValue } from './model.ts';
import { MODULES, type RecordModule } from './modules.ts';
import styles from './Records.module.css';

type Props = {
  module: RecordModule;
  scope: string;
  projectId: string;
  projectLabel: string;
  role: Role;
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
  const [module, setModule] = useState(props.module);
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

const RecordsWorkspace = ({ module, scope, projectId, projectLabel, role }: Props) => {
  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');
  const [selection, setSelection] = useState<{ id: string; mode: 'view' | 'edit' } | null>(null);
  const [creating, setCreating] = useState(false);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [notice, setNotice] = useState('');
  const [uploadBusy, setUploadBusy] = useState(false);
  const client = useQueryClient();
  const rows = useQuery(recordsQuery(module, scope, search));
  const detail = useQuery({
    ...recordQuery(module, scope, selection?.id ?? ''),
    enabled: selection !== null,
  });
  const definition = MODULES[module];
  const writable = canWriteRecords(role);
  const refresh = () =>
    Promise.all([
      client.invalidateQueries({ queryKey: ['records'] }),
      client.invalidateQueries({ queryKey: ['dashboard'] }),
      client.invalidateQueries({ queryKey: ['indicators'] }),
    ]);
  const save = useMutation({
    mutationFn: (values: Record<string, string>) =>
      saveRecord(
        module,
        scope,
        projectId,
        projectLabel,
        values,
        creating ? undefined : selection?.id,
      ),
    onSuccess: async (id) => {
      setCreating(false);
      setSelection(null);
      setNotice(`Registro ${id} guardado. Abre su ficha para adjuntar evidencias.`);
      await refresh();
    },
  });
  const remove = useMutation({
    mutationFn: (id: string) => deleteRecord(module, scope, id),
    onSuccess: async () => {
      setDeleting(null);
      setSelection(null);
      setNotice('Registro eliminado.');
      await refresh();
    },
  });
  const busy = save.isPending || remove.isPending || uploadBusy;
  return (
    <>
      {!writable ? (
        <Alert tone="info">
          Tu rol permite consultar estos registros. La edición y las cargas requieren permiso de
          escritura.
        </Alert>
      ) : null}
      {notice ? <Alert tone="success">{notice}</Alert> : null}
      <Card
        title={definition.label}
        action={
          writable ? (
            <Button
              disabled={busy}
              onClick={() => {
                save.reset();
                setNotice('');
                setSelection(null);
                setCreating(true);
              }}
            >
              Nuevo registro
            </Button>
          ) : undefined
        }
      >
        <form
          className={styles.search}
          onSubmit={(event) => {
            event.preventDefault();
            setSearch(searchInput.trim());
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
          {(data) => (
            <>
              <p className={styles.muted}>
                {data.length} registro(s)
                {data.length >= 500
                  ? ' · Se muestran los primeros 500. Refina la búsqueda para encontrar otros registros.'
                  : ''}
              </p>
              {data.length ? (
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
                        {definition.columns.map((key) => (
                          <th scope="col" key={key}>
                            {definition.fields.find((field) => field.key === key)?.label ?? key}
                          </th>
                        ))}
                        <th scope="col">Acciones</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.map((row) => (
                        <tr key={row._id}>
                          {definition.columns.map((key) => (
                            <td key={key}>
                              {fieldValue(
                                row,
                                definition.fields.find((field) => field.key === key) ?? {
                                  key,
                                  label: key,
                                },
                              ) || '—'}
                            </td>
                          ))}
                          <td>
                            <div className={styles.rowActions}>
                              <Button
                                variant="ghost"
                                disabled={busy}
                                aria-label={`Ver ${row._id}`}
                                onClick={() => {
                                  setCreating(false);
                                  setSelection({ id: row._id, mode: 'view' });
                                }}
                              >
                                Ver
                              </Button>
                              {writable ? (
                                <>
                                  <Button
                                    variant="ghost"
                                    disabled={busy}
                                    aria-label={`Editar ${row._id}`}
                                    onClick={() => {
                                      save.reset();
                                      setCreating(false);
                                      setNotice('');
                                      setSelection({ id: row._id, mode: 'edit' });
                                    }}
                                  >
                                    Editar
                                  </Button>
                                  <Button
                                    variant="ghost"
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
              ) : (
                <p>Sin registros para esta búsqueda.</p>
              )}
            </>
          )}
        </QueryState>
        {rows.error ? (
          <Button variant="secondary" onClick={() => void rows.refetch()}>
            Reintentar
          </Button>
        ) : null}
      </Card>
      {creating && writable ? (
        <Card title="Nuevo registro">
          <RecordEditor
            module={module}
            pending={save.isPending}
            error={message(save.error)}
            onSave={(values) => save.mutate(values)}
            onCancel={() => setCreating(false)}
          />
        </Card>
      ) : null}
      {selection ? (
        <Card
          title={`Ficha ${selection.id}`}
          action={
            <Button variant="ghost" disabled={busy} onClick={() => setSelection(null)}>
              Cerrar ficha
            </Button>
          }
        >
          <QueryState query={detail} label="la ficha">
            {(record) =>
              selection.mode === 'edit' && writable ? (
                <RecordEditor
                  key={record._id}
                  module={module}
                  record={record}
                  pending={save.isPending}
                  error={message(save.error)}
                  onSave={(values) => save.mutate(values)}
                  onCancel={() => setSelection(null)}
                />
              ) : (
                <>
                  <RecordDetail module={module} record={record} />
                  <EvidencePanel
                    key={`${scope}/${module}/${record._id}`}
                    module={module}
                    id={record._id}
                    scope={scope}
                    writable={writable}
                    onBusyChange={setUploadBusy}
                  />
                </>
              )
            }
          </QueryState>
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
