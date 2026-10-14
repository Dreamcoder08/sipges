import { DashboardResponse } from '@mascli/contracts';
import { useQuery } from '@tanstack/react-query';
import { requestJson } from '../api/client.ts';
import { Alert } from './Alert.tsx';

/**
 * Says when an analysis also reads the synthetic academic case. The dashboard counts real
 * records only, while IRSA and the situational and strategic engines read every record of the
 * project; without this notice their figures looked inconsistent with the dashboard.
 */
export const DemoDataNotice = ({ scope }: { scope: string }) => {
  const summary = useQuery({
    // Same key and request as the dashboard, so the cached summary is reused.
    queryKey: ['dashboard', scope, 'summary'],
    queryFn: ({ signal }) => requestJson('/api/dashboard', DashboardResponse, { scope, signal }),
  });
  // The counters overlap (prioritised actors, open demands), so only their presence is told.
  const hasDemo = Object.values(summary.data?.demostracion ?? {}).some((n) => n > 0);
  if (!hasDemo) return null;
  return (
    <Alert tone="info">
      Este análisis también usa los registros de demostración (caso académico sintético) del
      proyecto. El dashboard solo cuenta registros reales; en cada módulo, el filtro «Origen» los
      separa.
    </Alert>
  );
};
