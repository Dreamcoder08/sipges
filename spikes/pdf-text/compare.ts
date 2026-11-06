// Applies the production lexical reading to each candidate's page texts and diffs it against pdf.js.
import { readFileSync } from 'node:fs';
import { documentInsights } from '../../apps/api/src/contexts/documents/domain/insights.ts';
import { pdfChunks } from '../../apps/api/src/contexts/documents/domain/sources.ts';

type R = { outcome: string; pages?: string[]; ms: number; detail?: string };
const [basePath, ...cands] = process.argv.slice(2);
const verbose = process.env.VERBOSE === '1';
const base: Record<string, R> = JSON.parse(readFileSync(basePath!, 'utf8'));
const klass = (r: R | undefined) => {
  if (!r) return 'missing';
  if (r.outcome !== 'pages') return r.outcome === 'too_many_pages' ? 'too_many' : 'unreadable';
  return pdfChunks(r.pages!).length ? 'text' : 'no_text';
};
const findings = (r: R) => JSON.stringify(documentInsights(pdfChunks(r.pages ?? [])).items);
for (const path of cands) {
  const c: Record<string, R> = JSON.parse(readFileSync(path, 'utf8'));
  let same = 0, sameText = 0, n = 0;
  const miss: string[] = [];
  for (const f of Object.keys(base)) {
    n += 1;
    const a = base[f]!, b = c[f];
    if (klass(a) !== klass(b)) { miss.push(`${f}: class ${klass(a)} vs ${klass(b)}`); continue; }
    if (JSON.stringify(a.pages ?? []) === JSON.stringify(b?.pages ?? [])) sameText += 1;
    if (findings(a) === findings(b!)) same += 1;
    else {
      const fa = documentInsights(pdfChunks(a.pages!)).items, fb = documentInsights(pdfChunks(b!.pages!)).items;
      const i = fa.findIndex((x, k) => JSON.stringify(x) !== JSON.stringify(fb[k]));
      miss.push(`${f}: findings ${fa.length} vs ${fb.length}; first diff #${i}`);
      if (verbose) console.log(`   A ${fa[i]?.fragmento}\n   B ${fb[i]?.fragmento}`);
    }
  }
  const total = Object.values(c).reduce((s, r) => s + (r.ms ?? 0), 0);
  console.log(`${path.split('/').pop()}: findings ${same + 0}/${n} (identical text ${sameText}) ${total} ms`);
  for (const m of miss) console.log('  ' + m);
}
