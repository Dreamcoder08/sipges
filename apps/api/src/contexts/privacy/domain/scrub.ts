/**
 * Contact and identity numbers in free text, replaced by typed placeholders (docs/adr/0030).
 * Pure and deliberately conservative: a Peruvian DNI is only recognised next to the word that
 * names it, because eight digits alone are as likely to be an amount.
 */

const EMAIL = /[\p{L}\p{N}._%+-]+@[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)+/gu;

const DNI =
  /(\b(?:d\.?\s?n\.?\s?i\.?|documento(?:\s+(?:nacional\s+)?de\s+identidad)?|doc\.?(?:\s+de\s+identidad)?)\s*(?:n\.?\s?[°ºo]?\.?\s*|nro\.?\s*|n[uú]mero\s*)?[:#-]?\s*)\d{8}(?!\d)/giu;

const RUC = /(\bruc\s*[:#-]?\s*)\d{11}(?!\d)/giu;

/** Mobile (9 digits starting with 9, optional +51 / 0051) and landlines with an area code. */
const MOBILE = /(?<![\p{L}\p{N}])(?:(?:\+|00)\s?51[\s.-]?)?9(?:[\s.-]?\d){8}(?!\d)/gu;
const LANDLINE_PARENS = /(?<![\p{L}\p{N}])\(0?\d{1,2}\)[\s.-]?\d{3}[\s.-]?\d{3,4}(?!\d)/gu;
const LANDLINE_DASHED = /(?<![\p{L}\p{N}])0\d{1,2}[\s.-]\d{6,7}(?!\d)/gu;

export const PLACEHOLDERS = {
  email: '[correo]',
  phone: '[teléfono]',
  dni: '[DNI]',
  ruc: '[RUC]',
} as const;

export const scrubPatterns = (text: string): string =>
  text
    .replace(EMAIL, PLACEHOLDERS.email)
    .replace(DNI, `$1${PLACEHOLDERS.dni}`)
    .replace(RUC, `$1${PLACEHOLDERS.ruc}`)
    .replace(MOBILE, PLACEHOLDERS.phone)
    .replace(LANDLINE_PARENS, PLACEHOLDERS.phone)
    .replace(LANDLINE_DASHED, PLACEHOLDERS.phone);

/**
 * The ontology cuts titles and search excerpts with a «…», which can leave half an email or a
 * phone number at the edge. These are not whole patterns, so they are cleared apart: an unfinished
 * address before the mark, and a run of five or more digits touching it.
 */
const PARTIAL_EMAIL = /[\p{L}\p{N}._%+-]+@[\p{L}\p{N}.-]*(?=\s*…\s*$)/u;
const DIGITS_BEFORE_MARK = /\d[\d\s.-]*\d(?=\s*…\s*$)/u;
const DIGITS_AFTER_MARK = /(?<=^\s*…\s*)\d[\d\s.-]*\d/u;
const MIN_EDGE_DIGITS = 5;

export const scrubTruncated = (text: string): string => {
  const edge = (pattern: RegExp, current: string) =>
    current.replace(pattern, (run) =>
      run.replace(/\D/g, '').length >= MIN_EDGE_DIGITS ? PLACEHOLDERS.phone : run,
    );
  return edge(
    DIGITS_AFTER_MARK,
    edge(DIGITS_BEFORE_MARK, text.replace(PARTIAL_EMAIL, PLACEHOLDERS.email)),
  );
};
