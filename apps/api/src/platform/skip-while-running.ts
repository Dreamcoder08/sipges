export interface SkipWhileRunningHooks {
  /** Receives a rejected or synchronously thrown run; the next trigger may run again. */
  readonly onError: (error: unknown) => void;
  /**
   * Called when a trigger is dropped because the previous run is still in flight, with how long
   * that run has been running (a growing value means a hung run that blocks every later one).
   */
  readonly onSkip?: (runningForMs: number) => void;
  /** Clock in milliseconds; defaults to `Date.now`. */
  readonly now?: () => number;
}

/**
 * Wraps a periodic task so a trigger that fires while the previous run is still in flight is
 * skipped, not queued: a slow run never piles up overlapping runs that each hold resources.
 * The in-flight flag is local to one process timer; it never awaits work started elsewhere.
 * Returns whether the trigger started a run.
 */
export const skipWhileRunning = (
  task: () => Promise<unknown>,
  hooks: SkipWhileRunningHooks,
): (() => boolean) => {
  const now = hooks.now ?? Date.now;
  let running = false;
  let startedAt = 0;
  return () => {
    if (running) {
      hooks.onSkip?.(now() - startedAt);
      return false;
    }
    running = true;
    startedAt = now();
    let run: Promise<unknown>;
    try {
      run = task();
    } catch (error) {
      run = Promise.reject(error);
    }
    void run.catch(hooks.onError).finally(() => {
      running = false;
    });
    return true;
  };
};
