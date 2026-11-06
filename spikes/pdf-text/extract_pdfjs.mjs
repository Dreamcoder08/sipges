// Baseline: exactly apps/api/src/contexts/documents/infrastructure/pdf-text.ts over unpdf 2.1.0.
import { getDocumentProxy } from 'unpdf';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const [corpus, out] = process.argv.slice(2);
const MAX = 100;
const read = async (bytes) => {
  const pdf = await getDocumentProxy(new Uint8Array(bytes));
  try {
    if (pdf.numPages > MAX) return { outcome: 'too_many_pages' };
    const pages = [];
    for (let n = 1; n <= pdf.numPages; n += 1) {
      const page = await pdf.getPage(n);
      const content = await page.getTextContent();
      pages.push(content.items.map((i) => ('str' in i ? i.str + (i.hasEOL ? '\n' : '') : '')).join(''));
      page.cleanup();
    }
    return { outcome: 'pages', pages };
  } finally {
    await pdf.loadingTask.destroy();
  }
};
const res = {};
for (const f of readdirSync(corpus).filter((x) => x.endsWith('.pdf')).sort()) {
  const t = performance.now();
  try {
    res[f] = await read(readFileSync(join(corpus, f)));
  } catch (e) {
    res[f] = { outcome: 'error', detail: String(e?.name ?? e) };
  }
  res[f].ms = Math.round(performance.now() - t);
}
writeFileSync(out, JSON.stringify(res));
