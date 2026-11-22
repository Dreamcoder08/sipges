import { useQuery } from '@tanstack/react-query';
import { useEffect, useEffectEvent, useRef, useState } from 'react';
import { providersQuery } from '../../shared/api/providers.ts';
import { IdleWarningDialog } from './IdleWarningDialog.tsx';
import { type IdleWatch, watchIdleSession } from './idle-session.ts';

/**
 * Runs the idle timer while the API announces one (`idle_timeout_seconds`, Go API only): warns
 * two minutes before the deadline and calls `onExpired` when it passes. Without the field it
 * renders nothing and listens to nothing (world-class-local T8f).
 */
export const IdleSessionGuard = ({ onExpired }: { onExpired: () => void }) => {
  const seconds = useQuery(providersQuery).data?.idle_timeout_seconds;
  const [warning, setWarning] = useState(false);
  const watch = useRef<IdleWatch | null>(null);
  const expire = useEffectEvent(onExpired);
  useEffect(() => {
    if (!seconds) return;
    const current = watchIdleSession(seconds * 1000, { warn: setWarning, expire });
    watch.current = current;
    return () => {
      current.stop();
      watch.current = null;
      setWarning(false);
    };
  }, [seconds]);
  return warning ? <IdleWarningDialog onStay={() => watch.current?.stay()} /> : null;
};
