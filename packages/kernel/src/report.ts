/**
 * Format-neutral report outline shared by every context that produces documents. Domains
 * describe a report as blocks; a renderer adapter turns it into DOCX (or a later format)
 * without the domain knowing the file layout.
 */
export type ReportBlock =
  | { readonly kind: 'title'; readonly text: string }
  | { readonly kind: 'heading'; readonly level: 1 | 2 | 3; readonly text: string }
  | { readonly kind: 'paragraph'; readonly text: string }
  | { readonly kind: 'bullet'; readonly text: string }
  | {
      readonly kind: 'table';
      readonly header: readonly string[];
      readonly rows: readonly (readonly string[])[];
    };

export type ReportDocument = { readonly blocks: readonly ReportBlock[] };

export const title = (text: string): ReportBlock => ({ kind: 'title', text });
export const heading = (level: 1 | 2 | 3, text: string): ReportBlock => ({
  kind: 'heading',
  level,
  text,
});
export const paragraph = (text: string): ReportBlock => ({ kind: 'paragraph', text });
export const bullet = (text: string): ReportBlock => ({ kind: 'bullet', text });
export const table = (
  header: readonly string[],
  rows: readonly (readonly string[])[],
): ReportBlock => ({
  kind: 'table',
  header,
  rows,
});
