import { Document, Packer, Paragraph } from 'docx';

/** A synthetic evidence file for preview tests: PDF, DOCX or plain text. */
export type EvidenceFixture = { format: 'pdf' | 'docx' | 'txt'; text: string };

/** A complete one-page ASCII PDF, with correct byte offsets and plain text for the reader. */
const pdf = (text: string): Uint8Array<ArrayBuffer> => {
  const ascii = text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\x20-\x7E\n]/g, ' ');
  const lines = ascii.split('\n').flatMap((line) => line.match(/.{1,78}/g) ?? ['']);
  const stream =
    'BT /F1 9 Tf 42 750 Td 14 TL\n' +
    lines.map((line, n) => `${n ? 'T* ' : ''}(${line.replace(/[\\()]/g, '\\$&')}) Tj`).join('\n') +
    '\nET';
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [4 0 R] /Count 1 >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 5 0 R /Resources << /Font << /F1 3 0 R >> >> >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
  ];
  let body = '%PDF-1.4\n';
  const offsets = objects.map((object, n) => {
    const offset = body.length;
    body += `${n + 1} 0 obj\n${object}\nendobj\n`;
    return offset;
  });
  const xref = body.length;
  body += `xref\n0 6\n0000000000 65535 f \n${offsets.map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(body);
};

export const renderEvidence = async (file: EvidenceFixture): Promise<Uint8Array<ArrayBuffer>> => {
  if (file.format === 'pdf') return pdf(file.text);
  if (file.format === 'txt') return new TextEncoder().encode(file.text);
  return new Uint8Array(
    await Packer.toBuffer(
      new Document({
        creator: 'SIPGES',
        title: 'Registro de seguimiento',
        sections: [{ children: file.text.split('\n').map((line) => new Paragraph(line)) }],
      }),
    ),
  );
};
