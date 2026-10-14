import { LINK_TYPES, checkLink } from './catalog.ts';
import { foldText } from './search.ts';

/** Titles shorter than this ("Sí", "N/A") would match almost any text. */
const MIN_TITLE_CHARS = 5;
const EXCERPT_RADIUS = 60;

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Where `title` appears as whole words in one of `fields`, with a short excerpt around it.
 */
export const findMention = (
  fields: Readonly<Record<string, string>>,
  title: string,
): { field: string; excerpt: string } | null => {
  const needle = foldText(title.trim()).replace(/\s+/g, ' ');
  if (Array.from(needle).length < MIN_TITLE_CHARS || /^[\p{N}\s-]+$/u.test(needle)) return null;
  const pattern = new RegExp(
    `(?<![\\p{L}\\p{N}])${escape(needle).replace(/ /g, '\\s+')}(?![\\p{L}\\p{N}])`,
    'u',
  );
  for (const [field, value] of Object.entries(fields)) {
    // Accent folding keeps lengths for precomposed text; otherwise excerpt from the start.
    const source = value.normalize('NFC');
    const folded = foldText(source);
    const match = pattern.exec(folded);
    if (!match) continue;
    const at = folded.length === source.length ? match.index : 0;
    const start = Math.max(0, at - EXCERPT_RADIUS);
    const end = Math.min(source.length, at + match[0].length + EXCERPT_RADIUS);
    return {
      field,
      excerpt: `${start > 0 ? '…' : ''}${source.slice(start, end).trim()}${end < source.length ? '…' : ''}`,
    };
  }
  return null;
};

/**
 * The most specific link type the catalog allows between two object types, oriented as the
 * catalog reads it; the generic "relacionado con" when nothing else fits.
 */
export const suggestedLink = (
  a: { slug: string; id: string },
  b: { slug: string; id: string },
): { linkType: string; source: typeof a; target: typeof a } => {
  for (const type of LINK_TYPES) {
    // A mention says nothing about alliance or conflict, so symmetric judgements are skipped.
    if (type.symmetric) continue;
    if (!checkLink(type.id, a, b)) return { linkType: type.id, source: a, target: b };
    if (!checkLink(type.id, b, a)) return { linkType: type.id, source: b, target: a };
  }
  return { linkType: 'relacionado_con', source: a, target: b };
};
