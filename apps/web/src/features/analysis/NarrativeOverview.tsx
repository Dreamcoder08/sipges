import { useQuery } from '@tanstack/react-query';
import { moduleRecordsQuery } from '../../shared/api/module-records.ts';
import { Card } from '../../shared/ui/Card.tsx';
import { NarrativeCharts } from '../../shared/ui/NarrativeCharts.tsx';
import { QueryState } from '../../shared/ui/QueryState.tsx';

/** Compact narratives chart of the situational analysis, same model as Registros › Narrativas. */
export const NarrativeOverview = ({ scope }: { scope: string }) => {
  const rows = useQuery(moduleRecordsQuery('narrativas', scope));
  return (
    <Card eyebrow="Narrativas" title="Narrativas por categoría y en el tiempo">
      <QueryState query={rows} label="las narrativas">
        {(data) => <NarrativeCharts rows={data} window={90} compact />}
      </QueryState>
    </Card>
  );
};
