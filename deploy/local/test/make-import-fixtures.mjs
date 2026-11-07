/* global process, Buffer */
// Writes the synthetic client files the import drill reads: a legacy installation folder and a
// Base Maestra JSON. Every value is invented. Node 22.5 or later, for node:sqlite.
import { createHash, pbkdf2Sync, randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { crc32 } from 'node:zlib';

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

// A mixed folder for the inventory. Every cell below a header carries the mark the drill searches
// for: finding it in the report means a value got out.
const CANARY = 'CANARY-SYNTHETIC-VALUE';
const mixed = join(folder, 'mixed');
mkdirSync(join(mixed, 'nested'), { recursive: true });

// A ZIP with stored entries: enough for a workbook, with no package to install.
const zip = (parts) => {
  const locals = [];
  const central = [];
  let offset = 0;
  for (const [name, text] of Object.entries(parts)) {
    const nameBytes = Buffer.from(name);
    const body = Buffer.from(text);
    const fields = Buffer.alloc(26);
    fields.writeUInt16LE(20, 0);
    fields.writeUInt32LE(crc32(body), 10);
    fields.writeUInt32LE(body.length, 14);
    fields.writeUInt32LE(body.length, 18);
    fields.writeUInt16LE(nameBytes.length, 22);
    locals.push(Buffer.from('PK\x03\x04', 'latin1'), fields, nameBytes, body);
    const entry = Buffer.alloc(14);
    entry.writeUInt32LE(offset, 10);
    central.push(Buffer.from('PK\x01\x02', 'latin1'), Buffer.alloc(2), fields, entry, nameBytes);
    offset += 30 + nameBytes.length + body.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(18);
  end.writeUInt16LE(Object.keys(parts).length, 4);
  end.writeUInt16LE(Object.keys(parts).length, 6);
  end.writeUInt32LE(directory.length, 8);
  end.writeUInt32LE(offset, 12);
  return Buffer.concat([...locals, directory, Buffer.from('PK\x05\x06', 'latin1'), end]);
};

writeFileSync(
  join(mixed, 'book.xlsx'),
  zip({
    'xl/workbook.xml': '<workbook><sheets><sheet name="Concesiones" sheetId="1" r:id="rId1"/></sheets></workbook>',
    'xl/_rels/workbook.xml.rels':
      '<Relationships><Relationship Id="rId1" Type="x/worksheet" Target="worksheets/sheet1.xml"/></Relationships>',
    'xl/sharedStrings.xml': `<sst><si><t>Codigo</t></si><si><t>Titular</t></si><si><t>${CANARY}</t></si></sst>`,
    'xl/worksheets/sheet1.xml':
      '<worksheet><sheetViews><sheetView><pane ySplit="1" state="frozen"/></sheetView></sheetViews>' +
      '<sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row>' +
      '<row r="2"><c r="A2"><v>1001</v></c><c r="B2" t="s"><v>2</v></c></row></sheetData></worksheet>',
  }),
);
writeFileSync(join(mixed, 'letter.docx'), zip({ 'word/document.xml': `<w:document>${CANARY}</w:document>` }));
writeFileSync(join(mixed, 'list.csv'), `Codigo;Monto\n${CANARY};12\n${CANARY};13\n`);
writeFileSync(join(mixed, 'scan.pdf'), `%PDF-1.7\n${CANARY}\n%%EOF\n`);
writeFileSync(join(mixed, 'nested', 'scan-copy.pdf'), `%PDF-1.7\n${CANARY}\n%%EOF\n`);
writeFileSync(join(mixed, 'old.xls'), Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]));
writeFileSync(join(mixed, 'photo.jpg'), Buffer.from([0xff, 0xd8, 0xff]));
