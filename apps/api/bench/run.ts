/**
 * T12 benchmarks of the processing hotspots (ADR 0005, behavior contract §7).
 *
 *   node bench/run.ts                 # engines + documents + semantic + HTTP (embedded PGlite)
 *   SIPGES_BENCH_DATABASE_URL=postgres://… node bench/run.ts   # HTTP against real PostgreSQL
 *   node bench/run.ts --quick --out results.json
 *
 * Synthetic data only (bench/synthetic.ts). Results go to docs/benchmarks/.
 */
import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { availableParallelism, cpus, totalmem } from 'node:os';
import { PGlite } from '@electric-sql/pglite';
import { automatedConsensus } from '../src/contexts/analytics/domain/consensus.ts';
import { candidatePairs } from '../src/contexts/analytics/domain/candidate-links.ts';
import { integratedAnalysis } from '../src/contexts/analytics/domain/integrated.ts';
import {
  type RecordsByModule,
  EXTENDED_MODULES,
  extendedRecords,
} from '../src/contexts/analytics/domain/records.ts';
import { strategicReport } from '../src/contexts/analytics/domain/reports.ts';
import { buildSituational } from '../src/contexts/analytics/domain/situational.ts';
import { strategicAssessment } from '../src/contexts/analytics/domain/strategic.ts';
import { compareFindings, documentInsights } from '../src/contexts/documents/domain/insights.ts';
import { pdfChunks } from '../src/contexts/documents/domain/sources.ts';
import { documentReader, docxRenderer } from '../src/contexts/documents/infrastructure/index.ts';
import {
  DEFAULT_IRSA_CONFIG,
  INDICATOR_MODULES,
  type ModuleRecords,
  computeIndicators,
  computeIrsa,
} from '../src/contexts/indicators/domain/index.ts';
import { createIntelligenceService } from '../src/contexts/intelligence/application/index.ts';
import { analyzeText, classifyRecord } from '../src/contexts/intelligence/domain/index.ts';
import { loadMigrations, migrate } from '../src/platform/database/migrator.ts';
import { pgliteClient } from '../src/platform/database/pglite.ts';
import { postgresClient } from '../src/platform/database/postgres.ts';
import type { SqlClient } from '../src/platform/database/sql-client.ts';
import { type Measurement, GATE, measure, table, tripsGate } from './harness.ts';
import { BENCHMARK_HTTP_PATHS, createBenchmarkSession } from './http-session.ts';
import {
  NEUTRAL_VOCABULARY,
  type Payload,
  syntheticPages,
  syntheticPdf,
  syntheticRecords,
  totalRecords,
} from './synthetic.ts';

const args = new Set(process.argv.slice(2));
const quick = args.has('--quick');
const outIndex = process.argv.indexOf('--out');
const outFile = outIndex > 0 ? process.argv[outIndex + 1] : undefined;
const SCALES = quick ? [1, 10] : [1, 10, 100];
const RUNS = quick ? 5 : 30;
const PROJECT = 'PRJ-SECHURA';
const GENERATED_AT = '2026-10-13T12:00:00Z';
const sha256 = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');

const results: Measurement[] = [];
const record = async (...params: Parameters<typeof measure>) => {
  const m = await measure(...params);
  results.push(m);
  console.log(`${m.scenario} [${m.scale}] p95=${m.p95}ms block=${m.loopBlock}ms`);
};

const byModule = (records: Record<string, Payload[]>): RecordsByModule =>
  Object.fromEntries(
    Object.entries(records).map(([module, rows]) => [
      module,
      rows.map((payload, i) => ({ id: `${module}-${i}`, payload })),
    ]),
  );

// 1. Pure engines over the tenant's records.
for (const scale of SCALES) {
  const records = syntheticRecords(scale);
  const label = `${scale}× (${totalRecords(records)} records)`;
  const stored = byModule(records);
  const indicatorInput = Object.fromEntries(
    INDICATOR_MODULES.map((m) => [m, (stored[m] ?? []).map((r) => ({ ...r.payload, _id: r.id }))]),
  ) as unknown as ModuleRecords;
  const extended = extendedRecords(stored, PROJECT);

  await record(
    'Indicators + IRSA',
    label,
    () => computeIrsa(DEFAULT_IRSA_CONFIG, computeIndicators(indicatorInput)),
    { runs: RUNS },
  );
  await record(
    'Situational analysis',
    label,
    () => buildSituational(stored, PROJECT, GENERATED_AT),
    {
      runs: RUNS,
    },
  );
  await record('Candidate links', label, () => candidatePairs(extended), { runs: RUNS });
  await record(
    'Integrated analysis',
    label,
    () => integratedAnalysis(extended, PROJECT, GENERATED_AT),
    {
      runs: RUNS,
    },
  );
  await record(
    'Consensus engine',
    label,
    () => automatedConsensus(extended, PROJECT, GENERATED_AT),
    {
      runs: RUNS,
    },
  );
  await record(
    'Strategic assessment',
    label,
    () => strategicAssessment(extended, PROJECT, GENERATED_AT),
    {
      runs: RUNS,
    },
  );
  const events = records.Eventos;
  await record(`Classifier (${events.length} events)`, label, () => events.map(classifyRecord), {
    runs: RUNS,
  });
  if (scale === 10) {
    const situation = buildSituational(stored, PROJECT, GENERATED_AT);
    const strategic = strategicAssessment(extended, PROJECT, GENERATED_AT);
    await record(
      'Strategic DOCX render',
      label,
      () => docxRenderer.render(strategicReport(extended, strategic, situation)),
      { runs: RUNS },
    );
  }
}

// 2. Documents: the lab's limits are 100 PDF pages and 75 findings per document.
const pages = syntheticPages(100);
const pdf = syntheticPdf(pages);
await record('PDF text extraction', '100 pages', () => documentReader.readPdf(pdf, 100), {
  runs: quick ? 3 : 10,
  warmup: 1,
});
const chunks = pdfChunks(pages.map((lines) => lines.join('\n')));
await record('Document insights, many themes', '100 pages', () => documentInsights(chunks), {
  runs: RUNS,
});
const neutral = pdfChunks(
  syntheticPages(100, 40, 3, NEUTRAL_VOCABULARY).map((lines) => lines.join('\n')),
);
await record('Document insights, no themes', '100 pages', () => documentInsights(neutral), {
  runs: RUNS,
});
const findings = documentInsights(chunks).items;
const other = documentInsights(
  pdfChunks(syntheticPages(100, 40, 99).map((l) => l.join('\n'))),
).items;
await record(
  `Compare findings (${findings.length}×${other.length})`,
  '2 documents',
  () => compareFindings(findings, other),
  { runs: RUNS },
);

// 3. Digital intelligence: keyword analysis and the semantic layer with a model that answers
//    after a fixed delay (latency-bound, not CPU-bound).
const narratives = syntheticRecords(10).Narrativas;
const text = syntheticPages(1, 60)[0]?.join(' ') ?? '';
await record(
  'Text analysis (RC 2.4)',
  '10× narratives',
  () => analyzeText({ text, projectId: PROJECT, sourceUrl: '' }, narratives, sha256),
  { runs: RUNS },
);
const MODEL_DELAY_MS = 40;
const slowModel = {
  egress: 'local' as const,
  model: 'synthetic',
  embed: (input: string) =>
    new Promise<number[]>((resolve) =>
      setTimeout(
        () =>
          resolve(
            Array.from({ length: 64 }, (_, i) => (input.charCodeAt(i % input.length) % 7) + 1),
          ),
        MODEL_DELAY_MS,
      ),
    ),
};
const intelligence = () =>
  createIntelligenceService({
    narratives: { read: async () => narratives },
    embeddings: slowModel,
    // The benchmark model is local, so the guard is never asked.
    egress: { open: async () => ({ ok: false, reason: 'disabled' }) },
    alerts: {} as never,
    clock: { now: () => new Date(GENERATED_AT) },
    randomHex: () => '000000000000',
  });
await record(
  `Semantic analysis, cold (model ${MODEL_DELAY_MS} ms/call)`,
  '8 embeddings',
  () =>
    intelligence().semanticAnalyze(
      { companyId: 'SIPGES', projectId: PROJECT },
      { text, sourceUrl: '', mode: 'semantic' },
    ),
  { runs: quick ? 3 : 10, warmup: 1 },
);
const warm = intelligence();
await record(
  `Semantic analysis, warm (model ${MODEL_DELAY_MS} ms/call)`,
  '1 embedding',
  () =>
    warm.semanticAnalyze(
      { companyId: 'SIPGES', projectId: PROJECT },
      { text, sourceUrl: '', mode: 'semantic' },
    ),
  { runs: RUNS },
);

// 4. End to end over HTTP: records read from the database, engine, JSON response.
const databaseUrl = process.env.SIPGES_BENCH_DATABASE_URL;
const openDatabase = async (): Promise<{
  sql: SqlClient;
  close: () => Promise<void>;
  kind: string;
}> => {
  if (databaseUrl) {
    const admin = postgresClient(databaseUrl);
    const name = `sipges_bench_${Date.now()}`;
    await admin.client.exec(`CREATE DATABASE ${name}`);
    const url = new URL(databaseUrl);
    url.pathname = `/${name}`;
    const db = postgresClient(url.toString());
    return {
      sql: db.client,
      kind: 'PostgreSQL',
      close: async () => {
        await db.close();
        await admin.client.exec(`DROP DATABASE ${name} WITH (FORCE)`);
        await admin.close();
      },
    };
  }
  const db = new PGlite();
  return { sql: pgliteClient(db), kind: 'embedded PGlite', close: () => db.close() };
};

const database = await openDatabase();
try {
  await migrate(database.sql, await loadMigrations());
  const session = await createBenchmarkSession(database.sql, slowModel);
  const httpScale = quick ? 10 : 10;
  const records = syntheticRecords(httpScale);
  const tenant = 'SIPGES/PRJ-SECHURA';
  for (const [module, rows] of Object.entries(records)) {
    for (let i = 0; i < rows.length; i += 500) {
      const batch = rows.slice(i, i + 500);
      await database.sql.query(
        `INSERT INTO module_records (tenant_id, module, id, payload, created_at, updated_at)
         SELECT $1, $2, x.id, x.payload, now(), now()
           FROM jsonb_to_recordset($3::text::jsonb) AS x(id text, payload jsonb)`,
        [
          tenant,
          module,
          JSON.stringify(batch.map((payload, j) => ({ id: `${module}-${i + j}`, payload }))),
        ],
      );
    }
  }
  const label = `${httpScale}× (${totalRecords(records)} records), ${database.kind}`;
  for (const path of BENCHMARK_HTTP_PATHS) {
    await record(`HTTP GET ${path}`, label, () => session.get(path), { runs: RUNS });
  }
} finally {
  await database.close();
}

console.log(`\n${table(results)}\n`);
const over = results.filter(tripsGate);
console.log(
  over.length
    ? `Gate (p95 > ${GATE.p95} ms or loop block > ${GATE.loopBlock} ms) tripped by: ${over.map((m) => `${m.scenario} [${m.scale}]`).join('; ')}`
    : `No scenario trips the ADR 0005 gate (p95 > ${GATE.p95} ms or loop block > ${GATE.loopBlock} ms).`,
);
if (outFile) {
  await writeFile(
    outFile,
    `${JSON.stringify(
      {
        date: new Date().toISOString(),
        node: process.version,
        cpu: cpus()[0]?.model ?? 'unknown',
        cores: availableParallelism(),
        memoryGiB: Math.round(totalmem() / 2 ** 30),
        database: databaseUrl ? 'PostgreSQL' : 'embedded PGlite',
        gate: GATE,
        results,
      },
      null,
      2,
    )}\n`,
  );
}
void EXTENDED_MODULES;
