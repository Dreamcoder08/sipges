/** Synthetic test documents; no real names or operational data. */

const escapePdfText = (text: string) => text.replace(/[\\()]/g, (ch) => `\\${ch}`);

/** Smallest valid PDF with one Helvetica text line per page (ASCII text only). */
export const minimalPdf = (pages: readonly string[]): Uint8Array => {
  const objects: string[] = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    `<< /Type /Pages /Kids [${pages.map((_, i) => `${4 + i * 2} 0 R`).join(' ')}] /Count ${pages.length} >>`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  pages.forEach((text, i) => {
    const stream = `BT /F1 12 Tf 72 720 Td (${escapePdfText(text)}) Tj ET`;
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${5 + i * 2} 0 R /Resources << /Font << /F1 3 0 R >> >> >>`,
      `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    );
  });
  let pdf = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(pdf.length);
    pdf += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  pdf += offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('');
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(pdf);
};

export const utf8 = (text: string) => new TextEncoder().encode(text);

export const SAMPLE_TEXT = [
  'La asamblea de la comunidad revisó el mandato de la junta directiva.',
  'Los pobladores presentaron una demanda de empleo local y capacitación.',
  'Se firmó un acta con compromiso, responsable y plazo de seguimiento.',
].join('\n');
