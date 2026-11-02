import { useQuery } from '@tanstack/react-query';
import { Card } from '../../shared/ui/Card.tsx';
import { QueryState } from '../../shared/ui/QueryState.tsx';
import { runtimeQuery } from './api.ts';
export const RuntimeCard = ({ scope }: { scope: string }) => {
  const query = useQuery(runtimeQuery(scope));
  return (
    <Card title="Procesamiento y entregas">
      <QueryState query={query} label="estado del procesamiento">
        {() => null}
      </QueryState>
      {query.data ? (
        <>
          <p>
            Al guardar registros:{' '}
            {query.data.event_processing
              ? 'procesamiento automático habilitado'
              : 'procesamiento automático desactivado'}
            .
          </p>
          <p>
            Respaldo programado:{' '}
            {query.data.cron_configured && query.data.cron_schedule
              ? `${query.data.cron_schedule} (UTC); el programador del servidor lo dispara sin garantía de latencia.`
              : 'sin programador diario verificado en este servidor'}
            .
          </p>
          <p>
            Los reintentos pendientes se procesan al despertar el motor. Para una frecuencia mayor,
            conecte un ejecutor al endpoint autenticado de cron.
          </p>
          {query.data.latest_attempt ? (
            <p>
              Último intento: {query.data.latest_attempt.started_at} ·{' '}
              {query.data.latest_attempt.source === 'event' ? 'registro' : 'programador'} ·{' '}
              {query.data.latest_attempt.status === 'completed'
                ? 'completado'
                : query.data.latest_attempt.status === 'failed'
                  ? 'fallido'
                  : 'en proceso'}
              {query.data.latest_attempt.error ? ` · ${query.data.latest_attempt.error}` : ''}.
            </p>
          ) : (
            <p>Aún no hay intentos registrados en este proyecto.</p>
          )}
          <p>Una entrega aceptada por el proveedor no confirma su lectura en el teléfono.</p>
        </>
      ) : null}
    </Card>
  );
};
