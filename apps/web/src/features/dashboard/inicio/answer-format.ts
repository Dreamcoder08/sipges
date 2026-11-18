import { objectHref } from '../../../shared/lib/navigation.tsx';
import type { AnalystSource } from './ask.ts';

/**
 * The few shapes an analyst answer may take (odd/tasks/chat-first-ui.md T8): paragraphs split by
 * a blank line, «- »/«* » bullet lists and «1. » numbered lists. Everything else is text. This is
 * a line scanner, not Markdown: no HTML, no links, no headings, nothing that could become markup.
 */
export type AnswerBlock =
  | { readonly kind: 'paragraph'; readonly text: string }
  | { readonly kind: 'bullets'; readonly items: readonly string[] }
  | { readonly kind: 'numbers'; readonly start: number; readonly items: readonly string[] };

// Linear: each pattern is anchored and its parts cannot overlap, so no input backtracks.
const BULLET = /^ {0,3}[-*][ \t]+(\S.*)$/;
const NUMBER = /^ {0,3}(\d{1,9})\.[ \t]+(\S.*)$/;

export const answerBlocks = (answer: string): AnswerBlock[] => {
  const blocks: AnswerBlock[] = [];
  let lines: string[] = [];
  // Typed by assertion: `close` resets it, which narrowing from a `null` initializer would miss.
  let list = null as { kind: 'bullets' | 'numbers'; start: number; items: string[] } | null;
  const close = () => {
    if (lines.length) blocks.push({ kind: 'paragraph', text: lines.join('\n') });
    if (list) blocks.push(list);
    lines = [];
    list = null;
  };
  for (const line of answer.replace(/\r\n?/g, '\n').split('\n')) {
    const bullet = BULLET.exec(line);
    const number = bullet ? null : NUMBER.exec(line);
    if (!line.trim()) {
      close();
    } else if (bullet || number) {
      const kind = bullet ? 'bullets' : 'numbers';
      if (list?.kind !== kind) {
        close();
        list = { kind, start: number ? Number(number[1]) : 1, items: [] };
      }
      list.items.push((bullet?.[1] ?? number?.[2] ?? '').trimEnd());
    } else {
      if (list) close();
      lines.push(line);
    }
  }
  close();
  return blocks;
};

export type BoldPart = { readonly text: string; readonly bold: boolean };

/**
 * `**` pairs in order: the text between a pair is bold, an unpaired or empty one stays literal.
 * Nothing nests; a split on the marker keeps this linear for any run of asterisks.
 */
export const boldParts = (text: string): BoldPart[] => {
  const pieces = text.split('**');
  // An odd number of markers: the last one has no partner and stays text.
  if (pieces.length % 2 === 0) {
    const tail = pieces.pop() ?? '';
    pieces[pieces.length - 1] += `**${tail}`;
  }
  const parts: BoldPart[] = [];
  pieces.forEach((piece, index) => {
    const bold = index % 2 === 1 && piece.trim() !== '';
    const part = index % 2 === 1 && !bold ? `**${piece}**` : piece;
    if (!part) return;
    const last = parts.at(-1);
    // Adjacent plain text is one part, so a long run of markers stays one text node.
    if (!bold && last && !last.bold) parts[parts.length - 1] = { text: last.text + part, bold };
    else parts.push({ text: part, bold });
  });
  return parts;
};

const plainInline = (text: string) =>
  boldParts(text)
    .map((part) => part.text)
    .join('');

/** A source's name: its title, or its id when it has none (as the answer shows it). */
export const sourceName = (source: AnalystSource) => source.title || source.id;

/**
 * «Copiar» (T6): what the answer shows, as plain text, then its numbered sources as
 * «[n] Título — /ruta». Nothing beyond what the answer shows: no record contents.
 */
export const answerPlainText = (answer: string, sources: readonly AnalystSource[]) => {
  const body = answerBlocks(answer)
    .map((block) =>
      block.kind === 'paragraph'
        ? plainInline(block.text)
        : block.items
            .map(
              (item, index) =>
                `${block.kind === 'bullets' ? '-' : `${block.start + index}.`} ${plainInline(item)}`,
            )
            .join('\n'),
    )
    .join('\n\n');
  if (!sources.length) return body;
  const listed = sources.map(
    (source) => `[${source.n}] ${sourceName(source)} — ${objectHref(source.module, source.id)}`,
  );
  return [body, '', 'Fuentes:', ...listed].join('\n');
};
