import type { Role } from '@sipges/contracts';
import { useQuery } from '@tanstack/react-query';
import { InternalLink, objectHref } from '../../../shared/lib/navigation.tsx';
import { QueryState } from '../../../shared/ui/QueryState.tsx';
import { Sheet } from '../../../shared/ui/Sheet.tsx';
import { recordQuery } from '../api.ts';
import { HistoryPanel } from '../HistoryPanel.tsx';
import { LinksPanel } from '../LinksPanel.tsx';
import { canWriteRecords } from '../model.ts';
import { MODULES, type RecordModule } from '../modules.ts';
import { RecordDetail } from '../RecordDetail.tsx';
import styles from './Hub.module.css';
import { summarize } from './summary.ts';
import { VerificationChip } from './VerificationChip.tsx';

export type OpenRecord = { module: RecordModule; id: string };

/**
 * One record beside the list (docs/adr/0015 sheet): its fields, links and append-only audit
 * trail, with the full 360° page one click away.
 */
export const RecordSheet = ({
  record,
  onClose,
  scope,
  role,
}: {
  record: OpenRecord | null;
  onClose: () => void;
  scope: string;
  role: Role;
}) => (
  <Sheet open={record !== null} onClose={onClose} title={record ? `Ficha ${record.id}` : ''}>
    {record ? (
      <SheetBody key={`${scope}/${record.module}/${record.id}`} {...{ record, scope, role }} />
    ) : null}
  </Sheet>
);

const SheetBody = ({
  record: { module, id },
  scope,
  role,
}: {
  record: OpenRecord;
  scope: string;
  role: Role;
}) => {
  const detail = useQuery(recordQuery(module, scope, id));
  return (
    <div className={styles.sheetBody}>
      <p className={styles.sheetLead}>
        <span className={styles.typeChip}>{MODULES[module].label}</span>
        <InternalLink href={objectHref(module, id)}>Abrir ficha completa</InternalLink>
      </p>
      <QueryState query={detail} label="la ficha">
        {(row) => {
          const summary = summarize(module, row);
          return (
            <>
              <p className={styles.sheetLead}>
                <VerificationChip letter={summary.verification} />
                {summary.validation ? (
                  <span className={styles.pill}>{summary.validation}</span>
                ) : null}
              </p>
              <RecordDetail module={module} record={row} />
              <LinksPanel module={module} id={id} scope={scope} writable={canWriteRecords(role)} />
              <HistoryPanel module={module} id={id} scope={scope} />
            </>
          );
        }}
      </QueryState>
    </div>
  );
};
