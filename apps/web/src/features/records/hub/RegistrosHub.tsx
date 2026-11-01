import type { Role } from '@sipges/contracts';
import { useQueries } from '@tanstack/react-query';
import { useState } from 'react';
import { Button } from '../../../shared/ui/Button.tsx';
import { Card } from '../../../shared/ui/Card.tsx';
import { ChipRow } from '../../../shared/ui/ChipRow.tsx';
import { QueryState } from '../../../shared/ui/QueryState.tsx';
import { recordsQuery } from '../api.ts';
import type { RecordModule } from '../modules.ts';
import { RecordsPage } from '../RecordsPage.tsx';
import { type Density, useDensity } from './density.ts';
import styles from './Hub.module.css';
import { type OpenRecord, RecordSheet } from './RecordSheet.tsx';
import { type RecordSummary, summarize } from './summary.ts';
import { TodosList } from './TodosList.tsx';

/** The record types the hub lists, in the order of the chips. */
export const HUB_TYPES = [
  ['eventos', 'Eventos'],
  ['actores', 'Actores'],
  ['directorio', 'Directorio territorial'],
  ['demandas', 'Demandas'],
  ['narrativas', 'Narrativas'],
  ['fuentes', 'Fuentes'],
  ['buzon', 'Buzón'],
] as const satisfies readonly (readonly [RecordModule, string])[];

const isType = (value: string | undefined): value is (typeof HUB_TYPES)[number][0] =>
  HUB_TYPES.some(([module]) => module === value);

type Props = {
  /** `?tipo=`: a record type, or `todos` (also the default) for the cross-type list. */
  tipo: string | undefined;
  onTipo: (tipo: string) => void;
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
 * cross-type list are read from each type's own list endpoint, so no API changed.
 */
export const RegistrosHub = ({ tipo, onTipo, ...context }: Props) => {
  const selected: 'todos' | RecordModule = isType(tipo) ? tipo : 'todos';
  const lists = useQueries({
    queries: HUB_TYPES.map(([module]) => recordsQuery(module, context.scope, '')),
  });
  const count = (query: (typeof lists)[number] | undefined) =>
    query?.data ? String(query.data.length) : query?.isError ? '—' : '…';
  const total = lists.every((query) => query.data)
    ? String(lists.reduce((sum, query) => sum + (query.data?.length ?? 0), 0))
    : lists.some((query) => query.isError)
      ? '—'
      : '…';
  const everything = {
    isPending: lists.some((query) => query.isPending),
    error: lists.find((query) => query.error)?.error ?? null,
    isFetching: lists.some((query) => query.isFetching),
    refetch: () => lists.forEach((query) => query.error && void query.refetch()),
    data: lists.every((query) => query.data)
      ? lists.flatMap((query, index) =>
          (query.data ?? []).map((row) => summarize(HUB_TYPES[index]?.[0] ?? 'eventos', row)),
        )
      : undefined,
  };
  const [open, setOpen] = useState<OpenRecord | null>(null);
  return (
    <div className={styles.hub}>
      <ChipRow label="Tipo de registro">
        <Button
          variant={selected === 'todos' ? 'primary' : 'secondary'}
          aria-pressed={selected === 'todos'}
          onClick={() => onTipo('todos')}
        >
          Todos <span className={styles.count}>{total}</span>
        </Button>
        {HUB_TYPES.map(([module, label], index) => (
          <Button
            key={module}
            variant={selected === module ? 'primary' : 'secondary'}
            aria-pressed={selected === module}
            onClick={() => onTipo(module)}
          >
            {label} <span className={styles.count}>{count(lists[index])}</span>
          </Button>
        ))}
      </ChipRow>
      <Workspace
        key={`${context.scope}/${selected}`}
        selected={selected}
        everything={everything}
        onOpen={setOpen}
        {...context}
      />
      <RecordSheet
        record={open}
        onClose={() => setOpen(null)}
        scope={context.scope}
        role={context.role}
      />
    </div>
  );
};

const Workspace = ({
  selected,
  everything,
  onOpen,
  ...context
}: Omit<Props, 'tipo' | 'onTipo'> & {
  selected: 'todos' | RecordModule;
  everything: Parameters<typeof QueryState<RecordSummary[]>>[0]['query'];
  onOpen: (record: OpenRecord) => void;
}) => {
  const [density, setDensity] = useDensity(selected);
  return (
    <>
      <ChipRow label="Densidad de filas">
        {DENSITIES.map(([value, label]) => (
          <Button
            key={value}
            size="sm"
            variant={density === value ? 'primary' : 'secondary'}
            aria-pressed={density === value}
            onClick={() => setDensity(value)}
          >
            {label}
          </Button>
        ))}
      </ChipRow>
      <div className={styles.density} data-density={density}>
        {selected === 'todos' ? (
          <Card title="Todos los registros">
            <QueryState query={everything} label="los registros">
              {(rows) => <TodosList rows={rows} onOpen={onOpen} />}
            </QueryState>
          </Card>
        ) : (
          <RecordsPage
            module={selected}
            onView={(id) => onOpen({ module: selected, id })}
            {...context}
          />
        )}
      </div>
    </>
  );
};
