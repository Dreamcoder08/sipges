/* global process */
// Writes the synthetic client files the import drill reads: a legacy installation folder and a
// Base Maestra JSON. Every value is invented. Node 22.5 or later, for node:sqlite.
import { createHash, pbkdf2Sync, randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const [folder, password] = process.argv.slice(2);
const data = join(folder, 'legacy', 'data');
mkdirSync(join(data, 'uploads'), { recursive: true });
mkdirSync(join(folder, 'seed'), { recursive: true });
const NOW = '2026-10-01T09:00:00';

const salt = randomBytes(16);
const iterations = 310000;
const hash = pbkdf2Sync(password, salt, iterations, 32, 'sha256').toString('hex');

const auth = new DatabaseSync(join(data, 'auth_global.db'));
auth.exec(`CREATE TABLE auth_users (username, full_name, password_hash, role, active, created_at, totp_secret, totp_enabled);
  CREATE TABLE auth_sessions (token_hash, username, expires_at, created_at);
  CREATE TABLE tenant_projects (company_id, project_id, label);
  CREATE TABLE access_grants (username, company_id, project_id);`);
auth
  .prepare('INSERT INTO auth_users VALUES (?,?,?,?,?,?,?,?)')
  .run('legacy.admin', 'Synthetic Legacy Admin', `pbkdf2_sha256$${iterations}$${salt.toString('hex')}$${hash}`, 'admin', 1, NOW, null, 0);
auth.prepare('INSERT INTO tenant_projects VALUES (?,?,?)').run('SIPGES', 'PRJ-SECHURA', 'Synthetic default project');
auth.prepare('INSERT INTO access_grants VALUES (?,?,?)').run('legacy.admin', 'SIPGES', 'PRJ-SECHURA');
auth.close();

const evidence = 'synthetic legacy evidence\n';
const stored = `${'a'.repeat(32)}_evidence.txt`;
writeFileSync(join(data, 'uploads', stored), evidence);

const tenant = new DatabaseSync(join(data, 'sipges.db'));
tenant.exec(`CREATE TABLE records (module, record_id, payload, created_at, updated_at);
  CREATE TABLE audit (id INTEGER PRIMARY KEY, ts, module, record_id, action, detail);
  CREATE TABLE attachments (id, stored_name, original_name, content_type, size_bytes, sha256, linked_module, linked_record_id, document_type, author, verification, notes, project_id, project_name, created_at);`);
tenant
  .prepare('INSERT INTO records VALUES (?,?,?,?,?)')
  .run('Compromisos', 'LEG-1', JSON.stringify({ ID_Compromiso: 'LEG-1', Texto: 'synthetic legacy record' }), NOW, NOW);
tenant
  .prepare('INSERT INTO audit (ts, module, record_id, action, detail) VALUES (?,?,?,?,?)')
  .run(NOW, 'Compromisos', 'LEG-1', 'CREATE', 'synthetic');
tenant
  .prepare('INSERT INTO attachments VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
  .run(
    'att-1',
    stored,
    'evidence.txt',
    'text/plain',
    evidence.length,
    createHash('sha256').update(evidence).digest('hex'),
    'Compromisos',
    'LEG-1',
    'Informe',
    'Synthetic',
    'Sin verificar',
    '',
    'PRJ-SECHURA',
    'Synthetic default project',
    NOW,
  );
tenant.close();

writeFileSync(
  join(folder, 'seed', 'seed.json'),
  JSON.stringify({
    Compromisos: [
      { ID_Compromiso: 'SEED-1', Texto: 'synthetic seed one', Proyecto_ID: 'PRJ-SECHURA' },
      { ID_Compromiso: 'SEED-2', Texto: 'synthetic seed two' },
    ],
    Alertas: [{ ID_Alerta: 'SEED-A1', Texto: 'synthetic alert' }],
    Usuarios: [{ Usuario: 'ignored' }],
  }),
);
writeFileSync(
  join(folder, 'seed', 'foreign.json'),
  JSON.stringify({ Compromisos: [{ ID_Compromiso: 'SEED-X', Proyecto_ID: 'OTHER-PROJECT' }] }),
);
