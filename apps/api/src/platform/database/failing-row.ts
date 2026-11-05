/** check_violation and not_null_violation: the two errors whose detail quotes a whole row. */
const QUOTES_THE_ROW = new Set(['23514', '23502']);

export const OMITTED_ROW = 'Failing row omitted';

/**
 * PostgreSQL's detail on these errors is `Failing row contains (…)`: every column, so a password
 * hash or a sealed secret of the row. Node prints it for an unhandled rejection, and a logger
 * could too. The error keeps its class, message, code and stack; only that detail goes.
 * The code decides, not the text, which the server's lc_messages can translate.
 */
export const withoutFailingRow = (error: unknown): unknown => {
  const fields = error as { code?: unknown; detail?: unknown } | null;
  if (typeof fields?.code === 'string' && QUOTES_THE_ROW.has(fields.code) && fields.detail) {
    fields.detail = OMITTED_ROW;
  }
  return error;
};
