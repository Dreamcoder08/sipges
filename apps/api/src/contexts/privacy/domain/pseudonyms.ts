/**
 * Stable per-project pseudonyms (docs/adr/0030). A pseudonym is a keyed hash of the kind and
 * the folded name, so the same name always maps to the same short token inside one project and
 * to a different one in another, and nothing has to be stored to keep it consistent. The
 * `mac` function carries the project key; this module never sees the key itself.
 */
import { scrubPatterns, scrubTruncated } from './scrub.ts';

export const PSEUDONYM_KINDS = ['Actor', 'Persona', 'Org'] as const;
export type PseudonymKind = (typeof PSEUDONYM_KINDS)[number];

/** A name the project already knows, from its actors, contacts and responsible people. */
export type KnownName = { readonly kind: PseudonymKind; readonly name: string };

/** Keyed hash of a message as lowercase hex (HMAC-SHA256 under the project key). */
export type Mac = (message: string) => string;

const TOKEN_HEX = 6;
/** Shorter names would match inside ordinary words once folded. */
const MIN_NAME_LENGTH = 3;
const WORD = /[\p{L}\p{N}]/u;
/** Longest fragment of a name looked for next to a truncation mark. */
const MAX_FRAGMENT = 80;
const MIN_TAIL_FRAGMENT = 3;
const MIN_HEAD_FRAGMENT = 4;
/** An actor outranks a person, a person an organisation, when one name has several kinds. */
const PRIORITY: Readonly<Record<PseudonymKind, number>> = { Actor: 0, Persona: 1, Org: 2 };

const foldChar = (char: string) => char.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();

/** Lower case, no accents, single spaces: the identity of a name. */
export const foldName = (name: string) =>
  Array.from(name, foldChar).join('').replace(/\s+/g, ' ').trim();

type Folded = {
  readonly text: string;
  /** Where each folded UTF-16 unit starts and ends in the original text. */
  readonly starts: readonly number[];
  readonly ends: readonly number[];
};

/** Folds `text` like `foldName` while remembering where every unit came from. */
const foldWithMap = (text: string): Folded => {
  let folded = '';
  const starts: number[] = [];
  const ends: number[] = [];
  let index = 0;
  for (const char of text) {
    const end = index + char.length;
    if (/\s/u.test(char)) {
      if (folded.endsWith(' ')) ends[ends.length - 1] = end;
      else {
        folded += ' ';
        starts.push(index);
        ends.push(end);
      }
    } else {
      const piece = foldChar(char);
      for (let unit = 0; unit < piece.length; unit++) {
        starts.push(index);
        ends.push(end);
      }
      folded += piece;
    }
    index = end;
  }
  return { text: folded, starts, ends };
};

const isWordAt = (text: string, position: number) => {
  const char = text[position];
  return char !== undefined && WORD.test(char);
};

export const createPseudonymiser = (input: { mac: Mac; names: readonly KnownName[] }) => {
  const kinds = new Map<string, PseudonymKind>();
  for (const { kind, name } of input.names) {
    const key = foldName(name);
    if (!key) continue;
    const known = kinds.get(key);
    if (!known || PRIORITY[kind] < PRIORITY[known]) kinds.set(key, kind);
  }
  // Longest first, so "Municipalidad de Sechura" wins over "Sechura".
  const searchable = [...kinds.keys()]
    .filter((key) => key.length >= MIN_NAME_LENGTH)
    .sort((a, b) => b.length - a.length || a.localeCompare(b));

  const pseudonym = (kind: PseudonymKind, name: string) =>
    `${kind}-${input
      .mac(`${kind}\u0000${foldName(name)}`)
      .slice(0, TOKEN_HEX)
      .toUpperCase()}`;

  /** The kind the project registered for `name`, if it knows it. */
  const kindOf = (name: string): PseudonymKind | undefined => kinds.get(foldName(name));

  /** Replaces every known name in `text`, whatever its case or accents. */
  const replaceNames = (text: string): string => {
    if (!searchable.length || !text) return text;
    const folded = foldWithMap(text);
    const spans: { from: number; to: number; key: string }[] = [];
    const taken = (from: number, to: number) => spans.some((s) => from < s.to && to > s.from);
    for (const key of searchable) {
      for (let at = folded.text.indexOf(key); at !== -1; at = folded.text.indexOf(key, at + 1)) {
        const to = at + key.length;
        if (isWordAt(folded.text, at - 1) || isWordAt(folded.text, to) || taken(at, to)) continue;
        spans.push({ from: at, to, key });
      }
    }
    if (!spans.length) return text;
    spans.sort((a, b) => a.from - b.from);
    let out = '';
    let cursor = 0;
    for (const span of spans) {
      const start = folded.starts[span.from] ?? 0;
      const end = folded.ends[span.to - 1] ?? text.length;
      out += text.slice(cursor, start);
      out += pseudonym(kinds.get(span.key) ?? 'Persona', span.key);
      cursor = end;
    }
    return out + text.slice(cursor);
  };

  /**
   * A title or excerpt cut by the ontology (`…`) can hold half a name: «Marcos Villan…» or
   * «…eva Prado». A fragment that starts a known name, right before a closing mark, or ends one,
   * right after an opening mark, is replaced by that name's pseudonym.
   */
  const replaceFragments = (text: string): string => {
    let out = text;
    const closing = /\s*…\s*$/.exec(out);
    if (closing) {
      const before = out.slice(0, closing.index);
      const folded = foldWithMap(before.slice(-MAX_FRAGMENT));
      const offset = before.length - Math.min(before.length, MAX_FRAGMENT);
      for (let at = 0; at < folded.text.length; at++) {
        if (isWordAt(folded.text, at - 1)) continue;
        const fragment = folded.text.slice(at).trimEnd();
        if (fragment.length < MIN_TAIL_FRAGMENT) break;
        const name = searchable.find(
          (key) => key.length > fragment.length && key.startsWith(fragment),
        );
        if (!name) continue;
        const start = offset + (folded.starts[at] ?? 0);
        out = `${before.slice(0, start)}${pseudonym(kinds.get(name) ?? 'Persona', name)}${out.slice(closing.index)}`;
        break;
      }
    }
    const opening = /^\s*…\s*/.exec(out);
    if (opening) {
      const after = out.slice(opening[0].length);
      const folded = foldWithMap(after.slice(0, MAX_FRAGMENT));
      for (let to = folded.text.length; to >= MIN_HEAD_FRAGMENT; to--) {
        if (isWordAt(folded.text, to) && to < folded.text.length) continue;
        const fragment = folded.text.slice(0, to).trimStart();
        if (fragment.length < MIN_HEAD_FRAGMENT) break;
        const name = searchable.find(
          (key) => key.length > fragment.length && key.endsWith(fragment),
        );
        if (!name) continue;
        const end = folded.ends[to - 1] ?? 0;
        out = `${out.slice(0, opening[0].length)}${pseudonym(kinds.get(name) ?? 'Persona', name)}${after.slice(end)}`;
        break;
      }
    }
    return out;
  };

  return {
    pseudonym,
    kindOf,
    /** Free text without contact data or any name the project knows, even half of one. */
    scrub: (text: string): string =>
      replaceFragments(replaceNames(scrubTruncated(scrubPatterns(text)))),
  };
};

export type Pseudonymiser = ReturnType<typeof createPseudonymiser>;
