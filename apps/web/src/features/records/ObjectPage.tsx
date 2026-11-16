import type { Role } from '@sipges/contracts';
import { useState } from 'react';
import { useMutation, useQueryClient, useQuery } from '@tanstack/react-query';
import { Card } from '../../shared/ui/Card.tsx';
import { QueryState } from '../../shared/ui/QueryState.tsx';
import { Alert } from '../../shared/ui/Alert.tsx';
import { Button } from '../../shared/ui/Button.tsx';
import { isApiError } from '../../shared/api/client.ts';
import { errorDetail } from '../../shared/api/feedback.ts';
import { NotFoundNotice } from '../../shared/ui/NotFoundNotice.tsx';
import { InternalLink } from '../../shared/lib/navigation.tsx';
import { RecordEditor } from './RecordEditor.tsx';
import { recordQuery, saveRecord } from './api.ts';
import { BriefingPanel } from './BriefingPanel.tsx';
import { ProposalsPanel } from './ProposalsPanel.tsx';
import { EvidencePanel } from './EvidencePanel.tsx';
import { GraphPanel } from './GraphPanel.tsx';
import { HistoryPanel } from './HistoryPanel.tsx';
import { LinksPanel } from './LinksPanel.tsx';
import { MarkingControl } from './MarkingControl.tsx';
import { canWriteRecords } from './model.ts';
import { MODULES, type RecordModule } from './modules.ts';
import { RecordDetail } from './RecordDetail.tsx';
import { linksQuery } from './ontology-api.ts';
import styles from './Records.module.css';

const isRecordModule = (value: string): value is RecordModule => Object.hasOwn(MODULES, value);

/** Where a missing record or type sends the person back to. */
const backHome = <InternalLink href="/inicio">Volver al inicio</InternalLink>;

/**
 * The screen that lists each record type (its old route opens the hub tab). A sheet goes back to
 * its own list, not to one fixed screen (functional-10 T16); a type without a list goes home.
 */
const LIST: Partial<Record<RecordModule, readonly [href: string, label: string]>> = {
  eventos: ['/eventos', 'Eventos'],
  actores: ['/actores', 'Actores'],
  directorio: ['/directorio', 'Directorio territorial'],
  demandas: ['/demandas', 'Demandas'],
  compromisos: ['/demandas', 'Demandas y compromisos'],
  narrativas: ['/narrativas', 'Narrativas'],
  fuentes: ['/fuentes', 'Fuentes'],
  alertas: ['/alertas', 'Alertas'],
  buzon: ['/buzon', 'Buzón'],
  lecciones: ['/lecciones', 'Lecciones'],
};
const backTo = (module: RecordModule, from: 'calidad' | undefined) => {
  if (from === 'calidad')
    return <InternalLink href="/calidad">Volver a calidad de datos</InternalLink>;
  const list = LIST[module];
  return list ? <InternalLink href={list[0]}>Volver a {list[1]}</InternalLink> : backHome;
};

const ObjectView = ({
  module,
  id,
  scope,
  role,
  projectId,
  projectLabel,
  from,
}: {
  module: RecordModule;
  id: string;
  scope: string;
  role: Role;
  projectId: string;
  projectLabel: string;
  from: 'calidad' | undefined;
}) => {
  const client = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [uploadBusy, setUploadBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const save = useMutation({
    mutationFn: ({
      values,
      extras,
    }: {
      values: Record<string, string>;
      extras: Record<string, string>;
    }) => saveRecord(module, scope, projectId, projectLabel, values, id, extras),
    onSuccess: async () => {
      await Promise.all([
        client.invalidateQueries({ queryKey: ['records'] }),
        client.invalidateQueries({ queryKey: ['dashboard'] }),
        client.invalidateQueries({ queryKey: ['indicators', scope] }),
        client.invalidateQueries({ queryKey: ['analysis', scope] }),
        client.invalidateQueries({ queryKey: ['operations', scope] }),
      ]);
      setEditing(false);
      setNotice('Registro guardado.');
    },
  });
  const record = useQuery(recordQuery(module, scope, id));
  const summary = useQuery(linksQuery(module, id, scope));
  const writable = canWriteRecords(role);
  const title = summary.data ? summary.data.record.title : id;
  // A valid type and an id the project does not hold: the record is missing, not the type.
  if (isApiError(record.error, 404))
    return (
      <NotFoundNotice title="Registro no encontrado" action={backHome}>
        No hay un registro de {MODULES[module].label.toLowerCase()} con el identificador «{id}» en
        el proyecto activo. Pudo ser eliminado o pertenecer a otro proyecto.
      </NotFoundNotice>
    );
  return (
    <div className={styles.page}>
      {backTo(module, from)}
      {notice ? <Alert tone="success">{notice}</Alert> : null}
      <Card
        eyebrow={`${MODULES[module].label} · ${id}`}
        title={title}
        action={
          writable && record.data && !editing ? (
            <Button
              disabled={uploadBusy}
              onClick={() => {
                save.reset();
                setNotice('');
                setEditing(true);
              }}
            >
              Editar datos del registro
            </Button>
          ) : undefined
        }
      >
        {summary.data ? (
          <MarkingControl
            module={module}
            id={id}
            scope={scope}
            marking={summary.data.record.marking}
            writable={writable}
          />
        ) : null}
        <QueryState query={record} label="el registro">
          {(data) =>
            editing ? (
              <RecordEditor
                module={module}
                scope={scope}
                record={data}
                pending={save.isPending}
                error={save.error ? errorDetail(save.error) : null}
                onSave={(values, extras) => save.mutate({ values, extras })}
                onCancel={() => setEditing(false)}
              />
            ) : (
              <RecordDetail module={module} record={data} />
            )
          }
        </QueryState>
      </Card>
      {record.data && !editing ? (
        <Card title="Análisis">
          <BriefingPanel module={module} id={id} scope={scope} />
          {writable ? <ProposalsPanel module={module} id={id} scope={scope} /> : null}
        </Card>
      ) : null}
      {record.data && !editing ? (
        <Card title="Relaciones y trazabilidad">
          <GraphPanel module={module} id={id} scope={scope} />
          <LinksPanel module={module} id={id} scope={scope} writable={writable} />
          <EvidencePanel
            module={module}
            id={id}
            scope={scope}
            writable={writable}
            onBusyChange={setUploadBusy}
          />
          <HistoryPanel module={module} id={id} scope={scope} />
        </Card>
      ) : null}
    </div>
  );
};

/** 360° view of one record: fields, links, evidence and history (docs/adr/0011). */
export const ObjectPage = ({
  module,
  id,
  scope,
  role,
  projectId,
  projectLabel,
  from,
}: {
  module: string;
  id: string;
  scope: string;
  role: Role;
  projectId: string;
  projectLabel: string;
  /** The screen that opened the sheet, when it is not the record's own list. */
  from?: 'calidad' | undefined;
}) => {
  // Module keys are lower case; an address written «/objeto/Eventos/…» means the same type.
  const key = module.toLowerCase();
  return isRecordModule(key) ? (
    <ObjectView
      key={`${scope}/${key}/${id}`}
      module={key}
      id={id}
      scope={scope}
      role={role}
      projectId={projectId}
      projectLabel={projectLabel}
      from={from}
    />
  ) : (
    <NotFoundNotice title="Tipo de registro no válido" action={backHome}>
      «{module}» no es un tipo de registro de SIPGES. Revise el enlace o vuelva al inicio.
    </NotFoundNotice>
  );
};
