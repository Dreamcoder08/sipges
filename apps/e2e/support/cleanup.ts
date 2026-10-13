/** Register each acquired resource immediately; release in reverse acquisition order. */
export const usingCleanup = async (
  build: (register: (cleanup: () => Promise<void>) => void) => Promise<void>,
): Promise<() => Promise<void>> => {
  const actions: Array<() => Promise<void>> = [];
  const cleanup = async () => {
    const errors: unknown[] = [];
    while (actions.length) {
      const release = actions.shift();
      if (!release) continue;
      try {
        await release();
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length) throw new AggregateError(errors, 'Temporary resource cleanup failed');
  };
  try {
    await build((action) => actions.unshift(action));
  } catch (error) {
    try {
      await cleanup();
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], 'Setup and resource cleanup failed', {
        cause: cleanupError,
      });
    }
    throw error;
  }
  return cleanup;
};
