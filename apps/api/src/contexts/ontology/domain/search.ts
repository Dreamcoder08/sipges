/** Same folding as the record_search_text SQL function (migration 0012). */
export const foldText = (text: string) => text.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

export const MAX_SEARCH_TERMS = 8;

/** Search words of a user query, folded; at most MAX_SEARCH_TERMS, each at least 2 chars. */
export const searchTerms = (raw: string): string[] =>
  [...new Set(foldText(raw).match(/[a-z0-9]+/g) ?? [])]
    .filter((term) => term.length >= 2 || /^\d$/.test(term))
    .slice(0, MAX_SEARCH_TERMS);

/** A to_tsquery expression where every term must match as a prefix; null when empty. */
export const toPrefixQuery = (terms: readonly string[]) =>
  terms.length ? terms.map((term) => `${term}:*`).join(' & ') : null;

/** First field whose text contains a term, with a short excerpt around it. */
export const matchExcerpt = (
  payload: Readonly<Record<string, unknown>>,
  terms: readonly string[],
  preferred: readonly string[],
): { field: string; excerpt: string } | null => {
  const fields = [...new Set([...preferred, ...Object.keys(payload).sort()])];
  for (const field of fields) {
    const value = payload[field];
    if (typeof value !== 'string' && typeof value !== 'number') continue;
    const text = String(value);
    const folded = foldText(text);
    const at = terms.map((term) => folded.indexOf(term)).find((index) => index >= 0);
    if (at === undefined) continue;
    const start = Math.max(0, at - 40);
    const end = Math.min(text.length, at + 80);
    return {
      field,
      excerpt: `${start > 0 ? '…' : ''}${text.slice(start, end).trim()}${end < text.length ? '…' : ''}`,
    };
  }
  return null;
};
