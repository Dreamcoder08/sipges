/** Hybrid ranking helpers (docs/adr/0014 §9); pure, so the ranking is reproducible. */

/** Below this cosine similarity a record is not considered related to the query. */
export const MIN_SIMILARITY = 0.45;
/** Reciprocal rank fusion constant (Cormack et al., 2009). */
const RRF_K = 60;
const MAX_TEXT_CODE_POINTS = 4000;

export const cosine = (a: readonly number[], b: readonly number[]): number => {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
};

/** The text a record is embedded from: its type, title and every text field. */
export const embeddingText = (
  typeLabel: string,
  title: string,
  payload: Readonly<Record<string, unknown>>,
): string => {
  const fields = Object.entries(payload)
    .filter(([, v]) => (typeof v === 'string' && v.trim()) || typeof v === 'number')
    .map(([k, v]) => `${k}: ${String(v).trim()}`);
  return Array.from([`${typeLabel}: ${title}`, ...fields].join('\n'))
    .slice(0, MAX_TEXT_CODE_POINTS)
    .join('');
};

/**
 * Fuses ranked key lists by reciprocal rank: an item high in either list ranks high, and one
 * found by both ranks highest. Ties keep the first list's order.
 */
export const fuseRankings = (lists: readonly (readonly string[])[], limit: number): string[] => {
  const score = new Map<string, number>();
  const firstSeen = new Map<string, number>();
  let order = 0;
  for (const list of lists) {
    list.forEach((key, rank) => {
      score.set(key, (score.get(key) ?? 0) + 1 / (RRF_K + rank + 1));
      if (!firstSeen.has(key)) firstSeen.set(key, order++);
    });
  }
  return [...score.keys()]
    .sort(
      (a, b) =>
        (score.get(b) ?? 0) - (score.get(a) ?? 0) ||
        (firstSeen.get(a) ?? 0) - (firstSeen.get(b) ?? 0),
    )
    .slice(0, limit);
};
