/**
 * RFC 4180 CSV parser (quoted fields, escaped quotes, CRLF, embedded newlines). The delimiter
 * is detected from the header line, so files exported by Spanish-locale spreadsheets
 * (semicolons) work as well as comma or tab separated ones. A leading BOM is ignored.
 */
export const detectDelimiter = (text: string) => {
  const header = text.replace(/^﻿/, '').split(/\r?\n/, 1)[0] ?? '';
  const counts = [',', ';', '\t'].map((d) => [d, header.split(d).length] as const);
  return counts.reduce((best, current) => (current[1] > best[1] ? current : best))[0];
};

export const parseCsv = (input: string, delimiter = detectDelimiter(input)): string[][] => {
  const text = input.replace(/^﻿/, '');
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (quoted) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += char;
    } else if (char === '"' && field === '') quoted = true;
    else if (char === delimiter) {
      row.push(field);
      field = '';
    } else if (char === '\n' || char === '\r') {
      if (char === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else field += char;
  }
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((cell) => cell.trim() !== ''));
};
