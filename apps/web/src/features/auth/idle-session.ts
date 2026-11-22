import { isApiError, onSessionRemaining, request } from '../../shared/api/client.ts';

/** The warning opens this long before the server would end the session. */
export const WARNING_MS = 2 * 60_000;
/**
 * Human activity sends a keepalive at most this often, and only once the server's deadline is
 * this much short of a full timeout: before that the server would not extend the session.
 */
export const KEEPALIVE_AFTER_MS = 5 * 60_000;
/** Keepalive request: a plain GET without the background header. */
export const KEEPALIVE_PATH = '/system/auth/sessions';
/** The longest the check sleeps; it also runs on every request answer and on tab wake. */
const MAX_TICK_MS = 30_000;
const ACTIVITY_EVENTS = ['pointerdown', 'keydown', 'wheel', 'touchstart'] as const;

export type IdlePhase = 'active' | 'warning' | 'expired';

/** Where the session stands `now`, given the deadline the server last told. */
export const idlePhase = (now: number, deadline: number): IdlePhase => {
  if (now >= deadline) return 'expired';
  return now >= deadline - WARNING_MS ? 'warning' : 'active';
};

/**
 * Activity keeps the session only if a keepalive reaches the server before the warning opens,
 * so with a timeout under twelve minutes the five minutes shrink to half the time left before it.
 */
const keepaliveAfter = (timeoutMs: number) =>
  Math.min(KEEPALIVE_AFTER_MS, Math.max(timeoutMs - WARNING_MS, 0) / 2);

export type IdleWatch = {
  /** «Seguir conectado» or Escape: close the warning and tell the server the person is here. */
  readonly stay: () => void;
  readonly stop: () => void;
};

/**
 * Follows the server's idle deadline for this tab (world-class-local T8f). The deadline is only
 * what the server tells in its answers (`onSessionRemaining`), background ones included, so a tab
 * that only polls follows another tab's activity; until the first such answer it waits and warns
 * nothing. Every decision reads the clock, never a tick count, so a tab that slept catches up on
 * its next check (visibilitychange or the coarse timer).
 */
export const watchIdleSession = (
  timeoutMs: number,
  on: { warn: (open: boolean) => void; expire: () => void },
): IdleWatch => {
  const after = keepaliveAfter(timeoutMs);
  let deadline: number | undefined;
  let keptAt = Date.now();
  let warned = false;
  let ended = false;
  let sending = false;
  // The deadline the server last confirmed when this tab was about to warn or end; another tab's
  // activity moves the server's deadline without this tab hearing of it.
  let confirmed: number | undefined;
  let probing = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const end = () => {
    if (ended) return;
    stop();
    on.warn(false);
    on.expire();
  };

  const keepalive = (): Promise<void> => {
    if (sending) return Promise.resolve();
    sending = true;
    keptAt = Date.now();
    // The own-sessions list: an authenticated route every role may call, so the session
    // middleware extends the session (`/system/auth/me` is public in Go and does not). Its
    // answer tells the new deadline through onSessionRemaining.
    return request(KEEPALIVE_PATH)
      .then(() => undefined)
      .catch((error: unknown) => {
        if (isApiError(error, 401)) end();
      })
      .finally(() => {
        sending = false;
      });
  };

  const check = () => {
    clearTimeout(timer);
    if (ended || deadline === undefined) return;
    const now = Date.now();
    const phase = idlePhase(now, deadline);
    if (phase !== 'active' && confirmed !== deadline) return confirm();
    if (phase === 'expired') return end();
    if (phase === 'warning' && !warned) {
      warned = true;
      on.warn(true);
    } else if (phase === 'active' && warned && !sending) {
      // Another tab's activity moved the deadline: the warning no longer applies.
      warned = false;
      on.warn(false);
    }
    const next = phase === 'active' ? deadline - WARNING_MS : deadline;
    timer = setTimeout(check, Math.min(Math.max(next - now, 0), MAX_TICK_MS));
  };

  /**
   * Asks the server before warning or ending: a background request that does not extend the
   * session but tells its remaining time, so a hidden tab follows another tab's activity. A 401
   * ends it; a failed request leaves the deadline this tab already had.
   */
  const confirm = () => {
    if (probing) return;
    probing = true;
    void request(KEEPALIVE_PATH, { background: true })
      .then(() => undefined)
      .catch((error: unknown) => {
        if (isApiError(error, 401)) end();
      })
      .finally(() => {
        probing = false;
        confirmed = deadline;
        check();
      });
  };

  const onActivity = () => {
    // While the warning is open only its button (or Escape) continues the session.
    if (warned || ended) return;
    const now = Date.now();
    const extendable = deadline === undefined || deadline - now < timeoutMs - after;
    if (extendable && now - keptAt >= after) void keepalive();
  };

  const offServer = onSessionRemaining((seconds) => {
    deadline = Date.now() + seconds * 1000;
    check();
  });
  const options = { passive: true, capture: true } as const;
  for (const type of ACTIVITY_EVENTS) document.addEventListener(type, onActivity, options);
  document.addEventListener('visibilitychange', check);

  function stop() {
    ended = true;
    clearTimeout(timer);
    offServer();
    for (const type of ACTIVITY_EVENTS) document.removeEventListener(type, onActivity, options);
    document.removeEventListener('visibilitychange', check);
  }

  check();
  return {
    stay: () => {
      if (ended) return;
      on.warn(false);
      // `warned` stays set until the keepalive is answered, so the check cannot reopen it first.
      void keepalive().then(() => {
        warned = false;
        check();
      });
    },
    stop,
  };
};
