/**
 * Differential run of `import:base-maestra` (TypeScript) against `import-base-maestra` (Rust)
 * on synthetic databases and synthetic seed files written by this script (never data/seed.json).
 *
 *   SIPGES_TOOLS_DATABASE_URL=postgres://postgres@127.0.0.1:5432/postgres \
 *     node engines/tools-parity/base-maestra.ts
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import type { SqlClient } from '../../apps/api/src/platform/database/sql-client.ts';
import { ROOT, type Scenario, runScenarios } from './harness.ts';

const TOOL = { ts: 'apps/api/src/tools/base-maestra/cli.ts', rust: 'import-base-maestra' };
const DIR = 'engines/tools-parity/.seeds';
const SEED_AT = '2026-01-02T03:04:05.678Z';

const write = (name: string, content: string | Buffer) => {
  writeFileSync(`${ROOT}${DIR}/${name}`, content);
  return `${DIR}/${name}`;
};

/** Raw JSON text: key order, duplicate keys and number spellings reach both parsers as written. */
const MIXED = `{
  "Eventos": [
    {"ID_Evento": "EV-1", "Titulo": "Mesa sintética", "Fecha": "2026-01-05", "z": 1, "a": {"b": [1, 2.50, -0, 1e21, 1.5e-7, 12345678901234567890]}},
    {"ID_Evento": 0, "Titulo": "id cero genera hash"},
    {"ID_Evento": -0.0, "Titulo": "menos cero"},
    {"ID_Evento": 7.0, "Titulo": "id numérico"},
    {"ID_Evento": "", "Titulo": "id vacío", "Titulo": "clave repetida gana la última"},
    {"Titulo": "sin id", "Notas": "\\u00a0 espacios \\u3000", "Emoji": "😀", "\\uffef": 1, "\\ud83d\\ude00": 2}
  ],
  "Actores": [
    {"ID_Actor": "A-1", "Nombre_Actor/Organizacion": "Comunidad sintética Ñandú"},
    {"ID_Actor": 12.5}
  ],
  "Hechos_Compartidos": [
    {"Asunto": "hecho", "Estado": "pendiente"},
    {"Asunto": "otro", "Lista": [{"y": 1, "x": 2}, null, true, false, "texto"]}
  ],
  "Buzon": [{"ID_Caso": "BZ-NO-SE-USA", "Asunto": "Buzón usa hash"}],
  "Usuarios": [{"ID_Usuario": "admin"}],
  "Roles": "no importa",
  "Narrativas": [],
  "Dialogos": [{"__proto__": "propia", "constructor": 1, "Proceso": "Diálogo"}]
}`;

const PROBLEMS = `{
  "Eventos": [{"ID_Evento": "E1"}, {"ID_Evento": "E1"}, [], null, 5, {"ID_Evento": true}, {"ID_Evento": {"x": 1}},
    {"ID_Evento": "${'x'.repeat(201)}"}, {"ID_Evento": "${'é'.repeat(200)}"}, {"Nota": "a\\u0000b"}, {"a\\u0000": 1}],
  "7": [],
  "Desconocido": [],
  "Actores": {},
  "Fuentes": [{"ID_Fuente": 1e400}],
  "Indicadores": [{"Codigo": "IND-1", "Valor": 3}],
  "Hechos_Compartidos": [{"Asunto": "hecho", "Estado": "pendiente"}, {"Estado": "pendiente", "Asunto": "hecho"}]
}`;

const large = () => {
  const rows = Array.from({ length: 1203 }, (_, i) => ({ Asunto: `Hecho sintético ${i}`, n: i }));
  return JSON.stringify({ Hechos_Compartidos: rows, Eventos: [{ ID_Evento: 'EV-PREVIO', Titulo: 'nuevo' }] });
};

const tenants = async (sql: SqlClient) => {
  for (const id of ['SIPGES/PRJ-SECHURA', 'SYN/PRJ-B']) {
    const [company, project] = id.split('/');
    await sql.query('INSERT INTO tenants (company_id, project_id, label) VALUES ($1, $2, $3)', [
      company,
      project,
      id,
    ]);
  }
  // A record the import must never overwrite.
  await sql.transaction(async (tx) => {
    await tx.exec(
      "SELECT set_config('app.tenant_id', 'SIPGES/PRJ-SECHURA', true), set_config('role', 'sipges_tenant', true)",
    );
    await tx.query(
      `INSERT INTO module_records (tenant_id, module, id, payload, created_at, updated_at)
       VALUES ('SIPGES/PRJ-SECHURA', 'Eventos', 'EV-PREVIO', '{"Titulo":"editado a mano"}', $1, $1)`,
      [SEED_AT],
    );
  });
};

const DUMPS = {
  module_records: `SELECT tenant_id, module, id, payload::text AS payload, marking,
      CASE WHEN created_at = '${SEED_AT}' THEN 'seed' ELSE 'run' END AS created, created_at = updated_at AS same
    FROM module_records ORDER BY tenant_id, module, id`,
  audit: `SELECT tenant_id, module, record_id, action, detail FROM audit ORDER BY id`,
  record_versions: `SELECT tenant_id, module, record_id, operation, payload::text AS payload, actor
    FROM record_versions ORDER BY id`,
};

mkdirSync(`${ROOT}${DIR}`, { recursive: true });
const files = {
  mixed: write('mixed.json', MIXED),
  problems: write('problems.json', PROBLEMS),
  large: write('large.json', large()),
  notObject: write('array.json', '[1, 2]'),
  scalar: write('scalar.json', '"texto"'),
  invalid: write('invalid.json', '{"Eventos": [}'),
  bom: write('bom.json', '﻿{}'),
  latin1: write('latin1.json', Buffer.from([0x7b, 0x22, 0x48, 0x65, 0x63, 0x68, 0x6f, 0x73, 0x5f, 0x43, 0x6f, 0x6d, 0x70, 0x61, 0x72, 0x74, 0x69, 0x64, 0x6f, 0x73, 0x22, 0x3a, 0x5b, 0x7b, 0x22, 0x41, 0x22, 0x3a, 0x22, 0xf1, 0x22, 0x7d, 0x5d, 0x7d])),
  empty: write('empty.json', '{}'),
  // Verifier reproducers: TypeScript's recursive hasNul overflows (RangeError, nothing written);
  // an unknown module is never walked; Zod drops a top-level __proto__ before the NUL check.
  deep: write('deep.json', `{"Intereses":[{"x":${'['.repeat(5000)}1${']'.repeat(5000)}}]}`),
  deepUnknown: write('deep-unknown.json', `{"Otro":[${'['.repeat(90000)}${']'.repeat(90000)}],"Eventos":[{"ID_Evento":"E-HONDO"}]}`),
  nulBeforeDeep: write(
    'nul-before-deep.json',
    `{"Eventos":[{"a":"\\u0000","x":${'['.repeat(3000)}1${']'.repeat(3000)}}]}`,
  ),
  protoNul: write('proto-nul.json', '{"Actores":[{"ID_Actor":"A9"}],"Eventos":[{"__proto__":"a\\u0000b"}]}'),
};

const scenarios: Scenario[] = [
  {
    name: 'mixed',
    seed: tenants,
    dumps: DUMPS,
    steps: [
      { args: ['--help'] },
      { args: [] },
      { args: ['--seed='] },
      { args: ['--seed', files.mixed, '--scope', 'sin-barra'] },
      { args: ['--seed', files.mixed, '--nope'] },
      { args: ['--seed', `${DIR}/no-existe.json`] },
      { args: ['--seed', files.invalid] },
      { args: ['--seed', files.bom] },
      { args: ['--seed', files.mixed], env: { SIPGES_DATA_KEY: 'corta' } },
      { args: ['--seed', files.mixed, '--scope', 'NO/EXISTE'] },
      { args: ['--seed', files.notObject] },
      { args: ['--seed', files.scalar, '--apply'] },
      { args: ['--seed', files.empty, '--apply'] },
      { args: ['--seed', files.problems] },
      { args: ['--seed', files.problems, '--apply'] },
      { args: ['--seed', files.mixed] },
      { args: ['--', '--seed', files.mixed, '--apply'] },
      { args: ['--seed', files.mixed, '--apply'] },
      { args: ['--seed', files.mixed, '--scope=SYN/PRJ-B', '--apply'] },
      { args: ['--seed', files.latin1, '--apply'] },
      { args: ['--seed', files.deep, '--apply'] },
      { args: ['--seed', files.deepUnknown, '--apply'] },
      { args: ['--seed', files.nulBeforeDeep, '--apply'] },
      { args: ['--seed', files.protoNul] },
      { args: ['--seed', files.protoNul, '--apply'] },
    ],
  },
  {
    name: 'large',
    seed: tenants,
    dumps: {
      ...DUMPS,
      module_records: `SELECT module, count(*)::int AS n, md5(string_agg(id || payload::text, ',' ORDER BY id)) AS digest
        FROM module_records GROUP BY module ORDER BY module`,
      record_versions: `SELECT module, operation, count(*)::int AS n FROM record_versions GROUP BY 1, 2 ORDER BY 1, 2`,
    },
    steps: [{ args: ['--seed', files.large] }, { args: ['--seed', files.large, '--apply'] }, { args: ['--seed', files.large, '--apply'] }],
  },
  {
    // Interrupted: Hechos_Compartidos fails mid-file; Eventos (later in the file) never runs.
    name: 'interrupted',
    seed: tenants,
    dumps: {
      ...DUMPS,
      module_records: `SELECT module, count(*)::int AS n FROM module_records GROUP BY module ORDER BY module`,
      record_versions: `SELECT module, operation, count(*)::int AS n FROM record_versions GROUP BY 1, 2 ORDER BY 1, 2`,
    },
    prepare: async (sql) => {
      await sql.exec(`
        CREATE FUNCTION tooldiff_fail() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          IF NEW.module = 'Hechos_Compartidos' AND NEW.payload->>'n' = '1100' THEN
            RAISE EXCEPTION 'synthetic interruption';
          END IF;
          RETURN NEW;
        END $$;
        CREATE TRIGGER tooldiff_fail BEFORE INSERT ON module_records FOR EACH ROW EXECUTE FUNCTION tooldiff_fail();`);
    },
    steps: [
      { args: ['--seed', files.mixed, '--apply'] },
      { args: ['--seed', files.large, '--apply'] },
      { args: ['--seed', files.large, '--apply'], before: (sql) => sql.exec('DROP TRIGGER tooldiff_fail ON module_records') },
    ],
  },
];

try {
  process.exitCode = (await runScenarios(TOOL, scenarios)) === 0 ? 0 : 1;
} finally {
  rmSync(`${ROOT}${DIR}`, { recursive: true, force: true });
}
