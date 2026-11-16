import { DesktopUpdateStarted, DesktopUpdateStatus } from '@sipges/contracts';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useEffectEvent, useId, useState } from 'react';
import { isApiError, request, requestJson } from '../../shared/api/client.ts';
import { Alert } from '../../shared/ui/Alert.tsx';
import { Button } from '../../shared/ui/Button.tsx';
import styles from './DesktopUpdateNotice.module.css';

/**
 * `<meta name="sipges-desktop">`, added to index.html only by the desktop package builder
 * (deploy/desktop/package/builder.mjs). The cloud and development builds lack it, so they never
 * ask for, or show, the update notice.
 */
export const DESKTOP_MARKER = 'sipges-desktop';
const PATH = '/system/desktop/update';
/** The launcher boots the new version in about a minute; after this the user is told to reopen. */
const GIVE_UP_MS = 10 * 60_000;

const isDesktopBuild = () =>
  typeof document !== 'undefined' &&
  document.querySelector(`meta[name="${DESKTOP_MARKER}"]`) !== null;

type Restarting = { readonly from: string | null; readonly to: string };

type Progress =
  | { phase: 'idle' }
  | { phase: 'starting' }
  | { phase: 'restarting'; watch: Restarting }
  | { phase: 'failed'; message: string };

/** Waits for SIPGES to stop and start again; reports the version it came back with. */
const useRestartWatch = (
  restarting: Restarting | null,
  scope: string,
  pollMs: number,
  decided: (installed: string | null | undefined) => void,
) => {
  const decide = useEffectEvent(decided);
  useEffect(() => {
    if (!restarting) return;
    let stopped = false;
    let wentDown = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = Date.now() + GIVE_UP_MS;
    const tick = async () => {
      if (Date.now() > deadline) return decide(undefined);
      try {
        const status = await requestJson(PATH, DesktopUpdateStatus, { scope });
        if (stopped) return;
        // Back on the target version, or back on the old one after it went down: decided.
        if (status.installed === restarting.to || wentDown) return decide(status.installed);
      } catch {
        wentDown = true;
      }
      if (!stopped) timer = setTimeout(() => void tick(), pollMs);
    };
    timer = setTimeout(() => void tick(), pollMs);
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [restarting, scope, pollMs]);
};

/**
 * Update notice of the managed desktop app (odd/tasks/desktop-updates.md T3): the new version,
 * what changed and an explicit «Actualizar». Nothing is downloaded or installed before the click;
 * «Ahora no» hides it until SIPGES starts again. Administrators only; any refusal shows nothing.
 */
export const DesktopUpdateNotice = ({
  scope,
  pollMs = 2000,
  onUpdated = () => window.location.reload(),
}: {
  scope: string;
  pollMs?: number;
  onUpdated?: () => void;
}) => {
  const titleId = useId();
  const desktop = isDesktopBuild();
  const [hidden, setHidden] = useState(false);
  const [progress, setProgress] = useState<Progress>({ phase: 'idle' });
  const status = useQuery({
    queryKey: ['desktop-update'],
    queryFn: ({ signal }) => requestJson(PATH, DesktopUpdateStatus, { scope, signal }),
    enabled: desktop,
    retry: false,
    staleTime: Infinity,
    refetchOnWindowFocus: false,
  });
  const restarting = progress.phase === 'restarting' ? progress.watch : null;
  useRestartWatch(restarting, scope, pollMs, (installed) => {
    if (!restarting) return;
    if (installed === restarting.to) return onUpdated();
    setProgress({
      phase: 'failed',
      message:
        installed === undefined
          ? 'SIPGES no respondió después de actualizar. Ábrelo de nuevo desde el menú.'
          : `No se pudo completar la actualización. Sigues usando la versión ${installed ?? restarting.from ?? 'anterior'}.`,
    });
  });

  if (!desktop) return null;
  if (progress.phase === 'restarting')
    return (
      <div className={styles.slot}>
        <Alert tone="info">
          Actualizando a la versión {progress.watch.to}. SIPGES se reiniciará y esta página se
          recargará sola en un momento.
        </Alert>
      </div>
    );
  if (progress.phase === 'failed')
    return (
      <div className={styles.slot}>
        <Alert tone="error">{progress.message}</Alert>
      </div>
    );

  const data = status.data;
  if (hidden || !data?.available || data.dismissed) return null;
  const target = data.available;

  const decline = () => {
    setHidden(true);
    // Remembered by the server until the next start; a failure only means it asks again then.
    void request(`${PATH}/dismiss`, { method: 'POST', scope }).catch(() => undefined);
  };
  const update = async () => {
    setProgress({ phase: 'starting' });
    try {
      const started = DesktopUpdateStarted.parse(
        await (await request(PATH, { method: 'POST', scope })).json(),
      );
      setProgress({
        phase: 'restarting',
        watch: { from: data.installed, to: started.version },
      });
    } catch (error) {
      setProgress({
        phase: 'failed',
        message: `No se pudo iniciar la actualización: ${isApiError(error) ? error.detail : 'sin respuesta de SIPGES'}.`,
      });
    }
  };

  return (
    <div className={styles.slot}>
      <section className={styles.notice} aria-labelledby={titleId}>
        <h2 id={titleId} className={styles.title}>
          Nueva versión de SIPGES: {target}
        </h2>
        {data.installed ? <p className={styles.text}>Tienes la versión {data.installed}.</p> : null}
        {data.notes ? (
          <>
            <h3 className={styles.subtitle}>Qué cambió</h3>
            <p className={styles.notes}>{data.notes}</p>
          </>
        ) : null}
        <p className={styles.text}>
          SIPGES se cerrará unos segundos, guardará una copia de tus datos y volverá a abrirse en la
          nueva versión.
        </p>
        <div className={styles.actions}>
          <Button onClick={() => void update()} disabled={progress.phase === 'starting'}>
            Actualizar
          </Button>
          <Button variant="ghost" onClick={decline} disabled={progress.phase === 'starting'}>
            Ahora no
          </Button>
        </div>
      </section>
    </div>
  );
};
