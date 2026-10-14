import type { Role } from '@mascli/contracts';
import { useQuery } from '@tanstack/react-query';
import { Card } from '../../shared/ui/Card.tsx';
import { QueryState } from '../../shared/ui/QueryState.tsx';
import { recordQuery } from './api.ts';
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
}: {
  module: RecordModule;
  id: string;
  scope: string;
  role: Role;
}) => {
  const record = useQuery(recordQuery(module, scope, id));
  const summary = useQuery(linksQuery(module, id, scope));
  const writable = canWriteRecords(role);
  const title = summary.data ? summary.data.record.title : id;
  return (
    <div className={styles.page}>
      <Card eyebrow={`${MODULES[module].label} · ${id}`} title={title}>
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
          {(data) => <RecordDetail module={module} record={data} />}
        </QueryState>
      </Card>
      {record.data ? (
        <Card title="Análisis">
          <BriefingPanel module={module} id={id} scope={scope} />
          {writable ? <ProposalsPanel module={module} id={id} scope={scope} /> : null}
        </Card>
      ) : null}
      {record.data ? (
        <Card title="Relaciones y trazabilidad">
          <GraphPanel module={module} id={id} scope={scope} />
          <LinksPanel module={module} id={id} scope={scope} writable={writable} />
          <EvidencePanel
            module={module}
            id={id}
            scope={scope}
            writable={writable}
            onBusyChange={() => undefined}
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
}: {
  module: string;
  id: string;
  scope: string;
  role: Role;
}) =>
  isRecordModule(module) ? (
    <ObjectView
      key={`${scope}/${module}/${id}`}
      module={module}
      id={id}
      scope={scope}
      role={role}
    />
  ) : (
    <Card title="Tipo de registro no válido">
      <p>La dirección no corresponde a un tipo de registro de MASCLI.</p>
    </Card>
  );
