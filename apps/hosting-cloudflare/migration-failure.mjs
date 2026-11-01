// Lines for the deploy log when migrate.mjs fails. Never print the URL: client-side causes
// (connection, DNS) keep only their class, because their messages can name the host or carry
// credentials. A PostgreSQL server error has a five-character SQLSTATE and a message written by
// the server or by a migration's RAISE, which says why the migration stopped.
const SQLSTATE = /^[0-9A-Z]{5}$/;

export const describeMigrationFailure = (error) => {
  if (!(error instanceof Error)) return ['Migration failed'];
  const lines = [error.message];
  const cause = error.cause;
  if (cause instanceof Error) {
    const code = typeof cause.code === 'string' && SQLSTATE.test(cause.code) ? cause.code : null;
    lines.push(code ? `Cause: ${cause.name} ${code}: ${cause.message}` : `Cause: ${cause.name}`);
  }
  return lines;
};
