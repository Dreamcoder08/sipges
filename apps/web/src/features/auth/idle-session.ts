import { isApiError, onServerActivity, request } from '../../shared/api/client.ts';

/** The warning opens this long before the server would end the session. */
export const WARNING_MS = 2 * 60_000;
/** Human activity sends a keepalive once the last request the server saw is this old. */
export const KEEPALIVE_AFTER_MS = 5 * 60_000;
/** Keepalive request: a plain GET without the background header. */
export const KEEPALIVE_PATH = '/system/auth/sessions';
/** The longest the check sleeps; it also runs on every request answer and on tab wake. */
const MAX_TICK_MS = 30_000;
const ACTIVITY_EVENTS = ['pointerdown', 'keydown', 'wheel', 'touchstart'] as const;

export type IdlePhase = 'active' | 'warning' | 'expired';

/** Where the session stands `now`, given when the server last saw activity. */
export const idlePhase = (now: number, seenAt: number, timeoutMs: number): IdlePhase => {
  const deadline = seenAt + timeoutMs;
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
 * Follows the server's idle deadline for this tab (world-class-local T8f). The deadline counts
 * from the last request that extended the session (a keepalive or a user request); background
 * requests and `/system/auth/me` do not move it. Every decision reads the clock, never a tick count,
 * so a tab that slept catches up on its next check (visibilitychange or the coarse timer).
 */
export const watchIdleSession = (
  timeoutMs: number,
  on: { warn: (open: boolean) => void; expire: () => void },
): IdleWatch => {
  let seenAt = Date.now();
  let warned = false;
  let ended = false;
  let sending = false;
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
    // The own-sessions list: an authenticated route every role may call, so the session
    // middleware extends the session (`/system/auth/me` is public in Go and does not). Its
    // answer moves `seenAt` through onServerActivity.
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
    if (ended) return;
    const now = Date.now();
    const phase = idlePhase(now, seenAt, timeoutMs);
    if (phase === 'expired') return end();
    if (phase === 'warning' && !warned) {
      warned = true;
      on.warn(true);
    }
    const deadline = seenAt + timeoutMs;
    const next = phase === 'active' ? deadline - WARNING_MS : deadline;
    timer = setTimeout(check, Math.min(Math.max(next - now, 0), MAX_TICK_MS));
  };

  const onActivity = () => {
    // While the warning is open only its button (or Escape) continues the session.
    if (warned || ended) return;
    if (Date.now() - seenAt >= keepaliveAfter(timeoutMs)) void keepalive();
  };

  const offServer = onServerActivity(() => {
    seenAt = Date.now();
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
