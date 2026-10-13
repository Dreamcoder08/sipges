/**
 * Evidence upload rules (app.py:1063-1127, corrected per docs/adr/0008 #9): the extension
 * allowlist and name sanitizing keep parity; the content must also match the extension's
 * file signature, so a renamed executable or HTML page is refused.
 */

const ZIP = [0x50, 0x4b, 0x03, 0x04];
const OLE = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];

type Signature = { readonly contentType: string; readonly matches: (bytes: Uint8Array) => boolean };

const startsWith = (bytes: Uint8Array, prefix: readonly number[], offset = 0) =>
  bytes.length >= offset + prefix.length && prefix.every((b, i) => bytes[offset + i] === b);

const ascii = (text: string) => [...text].map((ch) => ch.charCodeAt(0));

/** Plain text: valid UTF-8 (BOM allowed) without NUL or other binary control bytes. */
const isText = (bytes: Uint8Array) => {
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return false;
  }
  // eslint-disable-next-line no-control-regex
  return !/[\u0000-\u0008\u000b\u000e-\u001f\u007f]/.test(text);
};

const SIGNATURES: Readonly<Record<string, Signature>> = {
  '.pdf': { contentType: 'application/pdf', matches: (b) => startsWith(b, ascii('%PDF-')) },
  '.doc': { contentType: 'application/msword', matches: (b) => startsWith(b, OLE) },
  '.docx': {
    contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    matches: (b) => startsWith(b, ZIP),
  },
  '.xls': { contentType: 'application/vnd.ms-excel', matches: (b) => startsWith(b, OLE) },
  '.xlsx': {
    contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    matches: (b) => startsWith(b, ZIP),
  },
  '.csv': { contentType: 'text/csv', matches: isText },
  '.txt': { contentType: 'text/plain', matches: isText },
  '.jpg': { contentType: 'image/jpeg', matches: (b) => startsWith(b, [0xff, 0xd8, 0xff]) },
  '.jpeg': { contentType: 'image/jpeg', matches: (b) => startsWith(b, [0xff, 0xd8, 0xff]) },
  '.png': {
    contentType: 'image/png',
    matches: (b) => startsWith(b, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  },
  '.webp': {
    contentType: 'image/webp',
    matches: (b) => startsWith(b, ascii('RIFF')) && startsWith(b, ascii('WEBP'), 8),
  },
};

export const ALLOWED_EXTENSIONS: readonly string[] = Object.keys(SIGNATURES);

const MAX_STEM = 80;

/** Lower-cased suffix like Python `Path(name).suffix` (a leading dot is not a suffix). */
export const extensionOf = (name: string) => {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot).toLowerCase() : '';
};

/**
 * app.py _safe_upload_name: base name only, ASCII-folded stem limited to [A-Za-z0-9._-]
 * (80 characters, trimmed of separators, `archivo` when empty) plus the lower-cased extension.
 */
export const safeUploadName = (raw: string): string => {
  const base = (raw || 'archivo').split(/[\\/]/).pop() || 'archivo';
  const ext = extensionOf(base);
  const stem = ext ? base.slice(0, base.length - ext.length) : base;
  const folded = stem
    .normalize('NFKD')
    .replace(/\P{ASCII}/gu, '')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^[-._]+|[-._]+$/g, '')
    .slice(0, MAX_STEM);
  return (folded || 'archivo') + ext;
};

export type UploadRejection =
  | { readonly kind: 'extension' }
  | { readonly kind: 'empty' }
  | { readonly kind: 'too_large'; readonly maxBytes: number }
  | { readonly kind: 'content_mismatch' };

export type AcceptedUpload = {
  readonly safeName: string;
  readonly contentType: string;
};

/** Validates name, size and signature; the detected type ignores the client's claim. */
export const checkUpload = (
  originalName: string,
  bytes: Uint8Array,
  maxBytes: number,
): { ok: true; value: AcceptedUpload } | { ok: false; error: UploadRejection } => {
  const safeName = safeUploadName(originalName);
  const signature = SIGNATURES[extensionOf(safeName)];
  if (!signature) return { ok: false, error: { kind: 'extension' } };
  if (bytes.length === 0) return { ok: false, error: { kind: 'empty' } };
  if (bytes.length > maxBytes) return { ok: false, error: { kind: 'too_large', maxBytes } };
  if (!signature.matches(bytes)) return { ok: false, error: { kind: 'content_mismatch' } };
  return { ok: true, value: { safeName, contentType: signature.contentType } };
};

/** Text limits applied to metadata, like the app.py slices. */
export const METADATA_LIMITS = {
  documentType: 120,
  author: 160,
  verification: 80,
  notes: 1000,
} as const;

export const DEFAULT_DOCUMENT_TYPE = 'Reporte / evidencia';
export const DEFAULT_VERIFICATION = 'E - No verificada';
