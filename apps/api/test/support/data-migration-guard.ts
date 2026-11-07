/** Statements that touch existing rows, as opposed to creating or altering structure. */
const REWRITES_ROWS =
  /\b(?:UPDATE\s+[a-z_"]+\s+SET|DELETE\s+FROM|INSERT\s+INTO\s+[a-z_"]+[^;]*?\bSELECT\b)/i;
const LIFTS_FORCE = /\bNO\s+FORCE\s+ROW\s+LEVEL\s+SECURITY\b/i;

/** Comments and quoted text are not statements: a note about UPDATE must not trip the check. */
const statementsOf = (sql: string) =>
  sql.replace(/--[^\n]*/g, ' ').replace(/'(?:[^']|'')*'/g, "''");

/**
 * Forced RLS hides rows from the owner, so a data migration with no tenant set reaches none of
 * them, with no error, and is recorded as applied. One that rewrites rows must lift FORCE first.
 */
export const needsForceLifted = (sql: string) => {
  const statements = statementsOf(sql);
  return REWRITES_ROWS.test(statements) && !LIFTS_FORCE.test(statements);
};
