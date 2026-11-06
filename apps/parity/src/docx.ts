import { inflateRawSync } from 'node:zlib';

const END_OF_DIRECTORY = 0x06054b50;
const DIRECTORY_ENTRY = 0x02014b50;
const DOCUMENT_PART = 'word/document.xml';
/** The stamp each API's clock prints in a report; the only text that differs between the two. */
const GENERATED_AT = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z/g;

/**
 * Reads word/document.xml out of a .docx. The zip container holds each API's own dates and
 * deflate output, so two equal reports never match byte for byte; this part must.
 */
export const documentText = (bytes: Uint8Array): string => {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let end = bytes.length - 22;
  while (end >= 0 && view.getUint32(end, true) !== END_OF_DIRECTORY) end--;
  if (end < 0) throw new Error('not a zip file');
  const entries = view.getUint16(end + 10, true);
  let at = view.getUint32(end + 16, true);
  for (let i = 0; i < entries; i++) {
    if (view.getUint32(at, true) !== DIRECTORY_ENTRY) throw new Error('corrupt zip directory');
    const compressedSize = view.getUint32(at + 20, true);
    const [nameSize, extraSize, commentSize] = [28, 30, 32].map((o) =>
      view.getUint16(at + o, true),
    );
    const offset = view.getUint32(at + 42, true);
    const name = new TextDecoder().decode(bytes.subarray(at + 46, at + 46 + (nameSize ?? 0)));
    if (name === DOCUMENT_PART) {
      const start =
        offset + 30 + view.getUint16(offset + 26, true) + view.getUint16(offset + 28, true);
      const xml = inflateRawSync(bytes.subarray(start, start + compressedSize)).toString('utf8');
      return xml.replaceAll(GENERATED_AT, '<generated_at>');
    }
    at += 46 + (nameSize ?? 0) + (extraSize ?? 0) + (commentSize ?? 0);
  }
  throw new Error(`no ${DOCUMENT_PART} in the zip file`);
};
