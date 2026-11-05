/**
 * Differential run of `review:materialize` (TypeScript) against `review-materialize` (Rust) on
 * synthetic databases: same exit code, stdout, stderr and written rows after every step.
 *
 *   SIPGES_TOOLS_DATABASE_URL=postgres://postgres@127.0.0.1:5432/postgres \
 *     node engines/tools-parity/review-materialize.ts
 *
 * Build the Rust binary first (`cargo build -p sipges-review-materialize` in engines/).
 */
import type { SqlClient } from '../../apps/api/src/platform/database/sql-client.ts';
import { type Scenario, runScenarios } from './harness.ts';

const TOOL = { ts: 'apps/api/src/tools/review-materialize/cli.ts', rust: 'review-materialize' };

const THEMES = [
  'Actor (extracción automática)',
  'Representatividad y gobernanza',
  'Demandas e intereses',
  'Compromisos y trazabilidad',
  'Controversias y hechos compartidos',
  'Diálogo y construcción de consensos',
  'Oportunidades de valor compartido',
  'Territorio y ambiente',
  'Tema libre sintético',
  '',
];
const STATUSES = ['pendiente', 'aceptado_para_revision', 'descartado', 'corroborado_documentalmente'];
const SEED_AT = '2026-01-02T03:04:05.678901Z';

const sha = (n: number) => n.toString(16).padStart(64, '0');

type Item = {
  tenant: string;
  id: string;
  theme: string;
  status: string;
  excerpt?: string;
  action?: string;
  reviewer?: string;
  note?: string;
  updatedAt?: string;
  sourceFile?: string;
  location?: string;
};

const insertItems = async (sql: SqlClient, items: readonly Item[]) => {
  for (let i = 0; i < items.length; i += 400) {
    const chunk = items.slice(i, i + 400).map((item, k) => ({
      tenant_id: item.tenant,
      id: item.id,
      project_id: item.tenant.split('/')[1],
      source_file: item.sourceFile ?? `informe-${(i + k) % 7}.pdf`,
      source_sha256: sha(i + k),
      location: item.location ?? `p. ${i + k}`,
      theme: item.theme,
      excerpt: item.excerpt ?? `Extracto sintético ${i + k}`,
      action: item.action ?? '',
      status: item.status,
      reviewer: item.reviewer ?? '',
      note: item.note ?? '',
      created_at: SEED_AT,
      updated_at: item.updatedAt ?? SEED_AT,
    }));
    await sql.query(
      `INSERT INTO document_review
       SELECT * FROM jsonb_populate_recordset(NULL::document_review, $1::jsonb)`,
      [JSON.stringify(chunk)],
    );
  }
};

const tenants = async (sql: SqlClient, ids: readonly string[]) => {
  for (const id of ids) {
    const [company, project] = id.split('/');
    await sql.query('INSERT INTO tenants (company_id, project_id, label) VALUES ($1, $2, $3)', [
      company,
      project,
      `Sintético ${id}`,
    ]);
  }
};

/** Every theme × status, edge texts, and an item already materialized and edited by hand. */
const seedMixed = async (sql: SqlClient) => {
  await tenants(sql, ['SYN/PRJ-A', 'SYN/PRJ-B', 'OTRA/PRJ-C', 'VACIA/PRJ-D']);
  const items: Item[] = [];
  let n = 0;
  for (const tenant of ['SYN/PRJ-A', 'SYN/PRJ-B', 'OTRA/PRJ-C'])
    for (const theme of THEMES)
      for (const status of STATUSES)
        items.push({
          tenant,
          id: `RV-${String(n++).padStart(4, '0')}`,
          theme,
          status,
          reviewer: n % 3 ? `revisor${n % 5}` : '',
          action: n % 2 ? `Verificar con fuente ${n}` : '',
          note: n % 4 === 0 ? 'Nota «sintética» con acentos: ñandú, 😀' : '',
          updatedAt: n % 5 === 0 ? '2026-03-31T23:59:59.999999-05:00' : SEED_AT,
        });
  items.push(
    // Whitespace JavaScript trims (NBSP, BOM, ideographic space) but Rust's trim would not all.
    {
      tenant: 'SYN/PRJ-A',
      id: 'RV-WS',
      theme: 'Compromisos y trazabilidad',
      status: 'aceptado_para_revision',
      excerpt: ' ﻿  Compromiso con espacios 　',
    },
    // U+0085 is whitespace for Rust, not for JavaScript.
    {
      tenant: 'SYN/PRJ-A',
      id: 'RV-NEL',
      theme: 'Tema libre sintético',
      status: 'corroborado_documentalmente',
      excerpt: '\u0085',
      note: 'Corroborado con acta sintética',
    },
    // A long id: REV-<id> beyond 200 UTF-16 units is refused for modules with an id field.
    {
      tenant: 'SYN/PRJ-B',
      id: `RV-${'é'.repeat(197)}`,
      theme: 'Demandas e intereses',
      status: 'aceptado_para_revision',
    },
    // Only one fresh item in its module: the single-record CREATE path.
    { tenant: 'OTRA/PRJ-C', id: 'RV-SOLO', theme: 'Territorio y ambiente', status: 'aceptado_para_revision' },
  );
  await insertItems(sql, items);
  // Already materialized and edited: insert-only must leave it untouched.
  await sql.transaction(async (tx) => {
    await tx.exec(
      "SELECT set_config('app.tenant_id', 'SYN/PRJ-A', true), set_config('role', 'sipges_tenant', true)",
    );
    await tx.query(
      `INSERT INTO module_records (tenant_id, module, id, payload, created_at, updated_at)
       VALUES ('SYN/PRJ-A', 'Demandas', 'REV-RV-0005', '{"Descripcion":"editado a mano"}', $1, $1)`,
      [SEED_AT],
    );
  });
};

/** 1,203 approved items in one tenant: three pages and three records batches per module. */
const seedLarge = async (sql: SqlClient) => {
  await tenants(sql, ['GRANDE/PRJ-X']);
  const items: Item[] = [];
  for (let n = 0; n < 1203; n++)
    items.push({
      tenant: 'GRANDE/PRJ-X',
      id: `RV-${String(n).padStart(5, '0')}`,
      theme: n % 3 ? 'Controversias y hechos compartidos' : 'Diálogo y construcción de consensos',
      status: n % 2 ? 'aceptado_para_revision' : 'corroborado_documentalmente',
    });
  await insertItems(sql, items);
};

const DUMPS = {
  module_records: `SELECT tenant_id, module, id, payload::text AS payload, marking,
      CASE WHEN created_at = '${SEED_AT}' THEN 'seed' ELSE 'run' END AS created,
      created_at = updated_at AS same_times
    FROM module_records ORDER BY tenant_id, module, id`,
  audit: `SELECT tenant_id, module, record_id, action, detail, event_payload::text AS event_payload,
      ts = (SELECT max(created_at) FROM module_records m WHERE m.tenant_id = a.tenant_id) AS at_last_write
    FROM audit a ORDER BY id`,
  record_versions: `SELECT tenant_id, module, record_id, operation, payload::text AS payload, actor, marking
    FROM record_versions ORDER BY id`,
};

const scenarios: Scenario[] = [
  {
    name: 'mixed',
    seed: seedMixed,
    dumps: DUMPS,
    steps: [
      { args: ['--help'] },
      { args: ['--scope', 'sin-barra'] },
      { args: ['--scope='] },
      { args: ['--scope', 'A/B/C'] },
      { args: ['--nope'] },
      { args: ['--apply=1'] },
      { args: ['posicional'] },
      { args: ['--scope'] },
      { args: [], env: { SIPGES_DATA_KEY: 'corta' } },
      { args: ['--scope', 'NO/EXISTE'] },
      { args: ['--', '--scope', 'NO/EXISTE', '--apply'] },
      { args: [] },
      { args: ['--scope', 'OTRA/PRJ-C', '--apply'] },
      { args: ['--scope=OTRA/PRJ-C', '--apply'] },
      { args: ['--apply'] },
      { args: ['--apply', '--'] },
      { args: [] },
    ],
  },
  {
    name: 'large',
    seed: seedLarge,
    dumps: {
      ...DUMPS,
      module_records: `SELECT module, count(*)::int AS n, md5(string_agg(id || payload::text, ',' ORDER BY id)) AS digest
        FROM module_records GROUP BY module ORDER BY module`,
      record_versions: `SELECT module, operation, count(*)::int AS n FROM record_versions GROUP BY 1, 2 ORDER BY 1, 2`,
    },
    steps: [{ args: [] }, { args: ['--apply'] }, { args: ['--apply'] }],
  },
  {
    // Interrupted run: the first insert into Hechos_Compartidos fails, after Dialogos committed.
    name: 'interrupted',
    seed: seedLarge,
    dumps: {
      ...DUMPS,
      module_records: `SELECT module, count(*)::int AS n FROM module_records GROUP BY module ORDER BY module`,
      record_versions: `SELECT module, operation, count(*)::int AS n FROM record_versions GROUP BY 1, 2 ORDER BY 1, 2`,
    },
    prepare: async (sql) => {
      await sql.exec(`
        CREATE FUNCTION tooldiff_fail() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          IF NEW.module = 'Hechos_Compartidos' AND NOT EXISTS (SELECT 1 FROM pg_class WHERE relname = 'tooldiff_unblock') THEN
            RAISE EXCEPTION 'synthetic interruption';
          END IF;
          RETURN NEW;
        END $$;
        CREATE TRIGGER tooldiff_fail BEFORE INSERT ON module_records FOR EACH ROW EXECUTE FUNCTION tooldiff_fail();`);
    },
    steps: [{ args: ['--apply'] }],
  },
];

process.exitCode = (await runScenarios(TOOL, scenarios)) === 0 ? 0 : 1;
