import assert from 'node:assert/strict';
import { test } from 'node:test';
import { deflateRawSync } from 'node:zlib';
import { documentText } from './docx.ts';

/** A one-entry zip file, built by hand: the reader needs no more of the format than this. */
const zip = (name: string, content: string) => {
  const nameBytes = Buffer.from(name);
  const data = deflateRawSync(Buffer.from(content));
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(nameBytes.length, 26);
  const entry = Buffer.alloc(46);
  entry.writeUInt32LE(0x02014b50, 0);
  entry.writeUInt32LE(data.length, 20);
  entry.writeUInt16LE(nameBytes.length, 28);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(30 + nameBytes.length + data.length, 16);
  return Buffer.concat([local, nameBytes, data, entry, nameBytes, end]);
};

test('reads the document part and masks the report date', () => {
  assert.equal(
    documentText(zip('word/document.xml', '<w:t>Corte: 2026-10-06T10:00:00Z ñ</w:t>')),
    '<w:t>Corte: <generated_at> ñ</w:t>',
  );
});

test('a file without the document part or a zip directory fails', () => {
  assert.throws(() => documentText(zip('word/styles.xml', 'x')), /no word\/document.xml/);
  assert.throws(() => documentText(new Uint8Array(40)), /not a zip file/);
});
