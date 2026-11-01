import type { Role } from '@sipges/contracts';
import { useState } from 'react';
import { useMutation, useQueryClient, useQuery } from '@tanstack/react-query';
import { Card } from '../../shared/ui/Card.tsx';
import { QueryState } from '../../shared/ui/QueryState.tsx';
import { Alert } from '../../shared/ui/Alert.tsx';
import { Button } from '../../shared/ui/Button.tsx';
import { errorDetail } from '../../shared/api/feedback.ts';
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

const ObjectView = ({
  module,
  id,
  scope,
  role,
  projectId,
  projectLabel,
}: {
  module: RecordModule;
  id: string;
  scope: string;
  role: Role;
  projectId: string;
  projectLabel: string;
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
  return (
    <div className={styles.page}>
      <InternalLink href="/calidad">Volver a calidad de datos</InternalLink>
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
}: {
  module: string;
  id: string;
  scope: string;
  role: Role;
  projectId: string;
  projectLabel: string;
}) =>
  isRecordModule(module) ? (
    <ObjectView
      key={`${scope}/${module}/${id}`}
      module={module}
      id={id}
      scope={scope}
      role={role}
      projectId={projectId}
      projectLabel={projectLabel}
    />
  ) : (
    <Card title="Tipo de registro no válido">
      <p>La dirección no corresponde a un tipo de registro de SIPGES.</p>
    </Card>
  );
