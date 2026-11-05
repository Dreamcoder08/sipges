/** The Node major CI runs parity on. Hono's body parsing differs on other majors. */
export const PARITY_NODE_MAJOR = 22;

/**
 * Why a run on this Node cannot be compared with CI, or null when it can. Multipart cases answer
 * differently on Node 26, so a different major reports differences that are not Go's.
 */
export const nodeVersionProblem = (version: string, allowed: boolean): string | null => {
  const major = Number(version.replace(/^v/, '').split('.')[0]);
  if (major === PARITY_NODE_MAJOR || allowed) return null;
  return `parity needs Node ${PARITY_NODE_MAJOR} (see .node-version), found ${version}; set SIPGES_PARITY_ANY_NODE=1 to run anyway`;
};
