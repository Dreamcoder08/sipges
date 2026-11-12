import type { Role } from '@sipges/contracts';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Button } from '../../../shared/ui/Button.tsx';
import { ChipRow } from '../../../shared/ui/ChipRow.tsx';
import { QueryState } from '../../../shared/ui/QueryState.tsx';
import { recordsSummaryQuery } from '../api.ts';
import { canWriteRecords } from '../model.ts';
import type { RecordModule } from '../modules.ts';
import { RecordsPage } from '../RecordsPage.tsx';
import { type Density, useDensity } from './density.ts';
import { useDocked } from './dock.ts';
import styles from './Hub.module.css';
import { HUB_TYPES } from './types.ts';
import { type OpenRecord, type OpenWay, RecordSheet } from './RecordSheet.tsx';
import type { RecordSummary } from './summary.ts';
import { TodosList } from './TodosList.tsx';
import { TypePicker } from './TypePicker.tsx';

const isType = (value: string | undefined): value is (typeof HUB_TYPES)[number][0] =>
  HUB_TYPES.some(([module]) => module === value);

/** `?ficha=<type>.<id>`: the record open in the sheet, so a reload or a link keeps it. */
const fichaOf = (record: OpenRecord | null) =>
  record ? `${record.module}.${record.id}` : undefined;
const parseFicha = (ficha: string | undefined): OpenRecord | null => {
  const at = ficha?.indexOf('.') ?? -1;
  const module = ficha?.slice(0, at);
  const id = ficha?.slice(at + 1);
  return at > 0 && isType(module) && id ? { module, id } : null;
};

type Props = {
  /** `?tipo=`: a record type, or `todos` (also the default) for the cross-type list. */
  tipo: string | undefined;
  onTipo: (tipo: string) => void;
  /** `?ficha=`: the record open in the sheet; `onFicha` writes it back to the URL. */
  ficha?: string | undefined;
  onFicha?: (ficha: string | undefined) => void;
  scope: string;
  projectId: string;
  projectLabel: string;
  role: Role;
};

const DENSITIES: readonly (readonly [Density, string])[] = [
  ['cozy', 'Cómoda'],
  ['compact', 'Compacta'],
];

/**
 * Registros as one destination (odd/tasks/workspace-architecture.md S3): chips by record type
 * with counts, one cross-type list, and the type screens unchanged underneath. Counts and the
 * cross-type list come from one request, GET /api/registros/summary.
 */
export const RegistrosHub = ({ tipo, onTipo, ficha, onFicha, ...context }: Props) => {
  const selected: 'todos' | RecordModule = isType(tipo) ? tipo : 'todos';
  const summary = useQuery(recordsSummaryQuery(context.scope));
  const pending = summary.isError ? '—' : '…';
  const counts = summary.data?.counts;
  const total = counts ? String(Object.values(counts).reduce((sum, n) => sum + n, 0)) : pending;
  const everything = {
    isPending: summary.isPending,
    error: summary.error,
    isFetching: summary.isFetching,
    refetch: () => void summary.refetch(),
    data: summary.data?.rows,
  };
  const [open, setRecord] = useState<OpenRecord | null>(() => parseFicha(ficha));
  const [way, setWay] = useState<OpenWay>('select');
  // A link to another record while the hub is open (the URL changed, not this component).
  const [linked, setLinked] = useState(ficha);
  if (ficha !== linked) {
    setLinked(ficha);
    if (ficha !== fichaOf(open)) setRecord(parseFicha(ficha));
  }
  const setOpen = (record: OpenRecord | null, how: OpenWay = 'select') => {
    setWay(how);
    setRecord(record);
    if (fichaOf(record) !== fichaOf(open)) onFicha?.(fichaOf(record));
  };
  const [intent, setIntent] = useState<{ module: RecordModule; kind: 'create' | 'import' } | null>(
    null,
  );
  const docked = useDocked();
  const choose = (next: string) => {
    setIntent(null);
    onTipo(next);
  };
  const begin = (kind: 'create' | 'import') => (module: RecordModule) => {
    setIntent({ module, kind });
    onTipo(module);
  };
  return (
    <div className={styles.hub}>
      <div className={styles.head}>
        <ChipRow label="Tipo de registro">
          <Button
            size="sm"
            variant={selected === 'todos' ? 'primary' : 'secondary'}
            aria-pressed={selected === 'todos'}
            onClick={() => choose('todos')}
          >
            Todos <span className={styles.count}>{total}</span>
          </Button>
          {HUB_TYPES.map(([module, label]) => (
            <Button
              key={module}
              size="sm"
              variant={selected === module ? 'primary' : 'secondary'}
              aria-pressed={selected === module}
              onClick={() => choose(module)}
            >
              {label}{' '}
              <span className={styles.count}>{counts ? String(counts[module]) : pending}</span>
            </Button>
          ))}
        </ChipRow>
        {selected === 'todos' && canWriteRecords(context.role) ? (
          <div className={styles.pageActions}>
            <TypePicker
              label="Importar"
              menuLabel="Tipo de la importación"
              icon="file"
              types={HUB_TYPES}
              onPick={begin('import')}
            />
            <TypePicker
              primary
              label="Nuevo registro"
              menuLabel="Tipo del nuevo registro"
              icon="plus"
              types={HUB_TYPES}
              onPick={begin('create')}
            />
          </div>
        ) : null}
      </div>
      <div className={styles.layout} data-docked={docked && open !== null}>
        <div className={styles.main}>
          <Workspace
            key={`${context.scope}/${selected}`}
            selected={selected}
            everything={everything}
            onOpen={setOpen}
            open={open}
            docked={docked}
            start={intent?.module === selected ? intent.kind : undefined}
            onStarted={() => setIntent(null)}
            {...context}
          />
        </div>
        <RecordSheet
          record={open}
          onClose={() => setOpen(null)}
          scope={context.scope}
          role={context.role}
          docked={docked}
          way={way}
        />
      </div>
    </div>
  );
};

const Workspace = ({
  selected,
  everything,
  onOpen,
  open,
  docked,
  start,
  onStarted,
  ...context
}: Omit<Props, 'tipo' | 'onTipo'> & {
  selected: 'todos' | RecordModule;
  everything: Parameters<typeof QueryState<readonly RecordSummary[]>>[0]['query'];
  onOpen: (record: OpenRecord, way?: OpenWay) => void;
  open: OpenRecord | null;
  /** Desktop: the sheet docks beside the list and Todos starts as the compact table. */
  docked: boolean;
  start: 'create' | 'import' | undefined;
  onStarted: () => void;
}) => {
  const [density, setDensity] = useDensity(
    selected,
    docked && selected === 'todos' ? 'compact' : 'cozy',
  );
  // The intent only opens the type screen once; later remounts must not reopen the form.
  useEffect(() => {
    if (start) onStarted();
  }, [start, onStarted]);
  const control = (
    <div role="group" aria-label="Densidad de filas" className={styles.segmented}>
      {DENSITIES.map(([value, label]) => (
        <button
          key={value}
          type="button"
          aria-pressed={density === value}
          onClick={() => setDensity(value)}
        >
          {label}
        </button>
      ))}
    </div>
  );
  return (
    <>
      {selected === 'todos' ? null : <div className={styles.densityRow}>{control}</div>}
      <div className={styles.density} data-density={density}>
        {selected === 'todos' ? (
          <QueryState query={everything} label="los registros">
            {(rows) => (
              <TodosList
                rows={rows}
                onOpen={onOpen}
                density={control}
                selected={open}
                docked={docked}
              />
            )}
          </QueryState>
        ) : (
          <RecordsPage
            module={selected}
            onView={(id) => onOpen({ module: selected, id })}
            start={start}
            {...context}
          />
        )}
      </div>
    </>
  );
};
