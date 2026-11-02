import type { Role } from '@sipges/contracts';
import { useQuery } from '@tanstack/react-query';
import { type ReactNode, useEffect, useLayoutEffect, useRef } from 'react';
import { InternalLink, objectHref } from '../../../shared/lib/navigation.tsx';
import { Icon } from '../../../shared/ui/Icon.tsx';
import { QueryState } from '../../../shared/ui/QueryState.tsx';
import { Sheet } from '../../../shared/ui/Sheet.tsx';
import { recordQuery } from '../api.ts';
import { HistoryPanel } from '../HistoryPanel.tsx';
import { LinksPanel } from '../LinksPanel.tsx';
import { canWriteRecords } from '../model.ts';
import type { RecordModule } from '../modules.ts';
import { RecordDetail } from '../RecordDetail.tsx';
import styles from './Hub.module.css';
import { summarize } from './summary.ts';
import { TypeChip } from './TypeChip.tsx';
import { ValidationChip, VerificationChip } from './VerificationChip.tsx';

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
  docked,
}: {
  record: OpenRecord | null;
  onClose: () => void;
  scope: string;
  role: Role;
  /** From 1280 px: beside the list and non-modal instead of the modal sheet. */
  docked: boolean;
}) => {
  const body = record ? (
    <SheetBody key={`${scope}/${record.module}/${record.id}`} {...{ record, scope, role }} />
  ) : null;
  if (docked)
    return record ? (
      <DockedSheet record={record} onClose={onClose}>
        {body}
      </DockedSheet>
    ) : null;
  return (
    <Sheet open={record !== null} onClose={onClose} title={record ? `Ficha ${record.id}` : ''}>
      {body}
    </Sheet>
  );
};

/**
 * The same record beside the list: not modal, so the list stays usable and picking another row
 * swaps the record. Esc closes it and focus returns to the control that opened it.
 */
const DockedSheet = ({
  record,
  onClose,
  children,
}: {
  record: OpenRecord;
  onClose: () => void;
  children: ReactNode;
}) => {
  const panel = useRef<HTMLElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const opener = useRef<HTMLElement | null>(null);
  const closeRef = useRef(onClose);
  useLayoutEffect(() => {
    closeRef.current = onClose;
  });
  const key = `${record.module}/${record.id}`;
  // Remember the row that asked for the record; picking another row updates it.
  useEffect(() => {
    const active = document.activeElement;
    if (active instanceof HTMLElement && !panel.current?.contains(active)) opener.current = active;
  }, [key]);
  useEffect(() => {
    heading.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      if (document.querySelector('[aria-modal="true"]')) return;
      closeRef.current();
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      if (opener.current?.isConnected) opener.current.focus();
    };
  }, []);
  return (
    <section
      ref={panel}
      role="dialog"
      aria-modal="false"
      aria-labelledby="record-sheet-title"
      className={styles.dock}
    >
      <div className={styles.dockHead}>
        <h2 id="record-sheet-title" ref={heading} tabIndex={-1}>
          Ficha {record.id}
        </h2>
        <button type="button" className={styles.dockClose} onClick={onClose}>
          <Icon name="close" />
          <span className="visually-hidden">Cerrar</span>
        </button>
      </div>
      {children}
    </section>
  );
};

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
        <TypeChip module={module} />
        <InternalLink href={objectHref(module, id)}>Abrir ficha completa</InternalLink>
      </p>
      <QueryState query={detail} label="la ficha">
        {(row) => {
          const summary = summarize(module, row);
          return (
            <>
              <p className={styles.sheetLead}>
                <VerificationChip letter={summary.verification} />
                {summary.validation ? <ValidationChip state={summary.validation} /> : null}
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
