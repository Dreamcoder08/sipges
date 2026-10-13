/**
 * Builds a SYNTHETIC legacy MASCLI installation (SQLite + JSON + uploads) in a temporary
 * directory. The table definitions are extracted from the legacy `app.py` CREATE statements,
 * so the fixture cannot drift from the schema it claims to migrate. No real or operational
 * data is read: every value here is invented for tests.
 */
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { pbkdf2Sync, createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const APP_PY = new URL('../../../../reference/python/app.py', import.meta.url);

/**
 * Pulls `CREATE TABLE IF NOT EXISTS <name>(...)` out of app.py by balancing parentheses.
 * Throws when a table disappears, which is the signal that the migration must be revisited.
 */
export const legacyCreateStatements = (): ReadonlyMap<string, string> => {
  const source = readFileSync(APP_PY, 'utf8');
  const statements = new Map<string, string>();
  const marker = /CREATE TABLE IF NOT EXISTS\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/g;
  let match: RegExpExecArray | null;
  while ((match = marker.exec(source)) !== null) {
    const name = match[1] ?? '';
    let depth = 1;
    let index = match.index + match[0].length;
    while (index < source.length && depth > 0) {
      const char = source[index];
      if (char === '(') depth += 1;
      if (char === ')') depth -= 1;
      index += 1;
    }
    statements.set(name, source.slice(match.index, index));
  }
  return statements;
};

export const legacyTable = (name: string): string => {
  const statement = legacyCreateStatements().get(name);
  if (!statement) throw new Error(`app.py no longer defines table ${name}`);
  return statement;
};

/** app.py:162-165 — PBKDF2-HMAC-SHA256, 310,000 iterations. */
export const legacyPasswordHash = (password: string, salt = 'a'.repeat(32)): string => {
  const derived = pbkdf2Sync(password, Buffer.from(salt, 'hex'), 310_000, 32, 'sha256');
  return `pbkdf2_sha256$310000$${salt}$${derived.toString('hex')}`;
};

export const scopeDirectory = (tenantId: string) =>
  createHash('sha256').update(tenantId).digest('hex').slice(0, 24);

const now = '2026-10-01T09:00:00';

export type LegacyFixture = {
  readonly root: string;
  readonly cleanup: () => Promise<void>;
  /** Password of both synthetic accounts (test-only value). */
  readonly password: string;
  readonly adminUser: string;
  readonly analystUser: string;
  readonly totpSecret: string;
  readonly defaultTenant: string;
  readonly otherTenant: string;
  readonly attachmentBytes: Uint8Array;
  readonly attachmentId: string;
  readonly otherAttachmentId: string;
  readonly eventId: string;
  readonly otherEventId: string;
  /** Distinctive strings that must never appear in logs or reports. */
  readonly secrets: readonly string[];
};

const exec = (db: DatabaseSync, statements: readonly string[]) => {
  for (const statement of statements) db.exec(statement);
};

export const buildLegacyFixture = async (): Promise<LegacyFixture> => {
  const root = await mkdtemp(join(tmpdir(), 'mascli-legacy-'));
  const data = join(root, 'data');
  const tenantDir = join(data, 'tenants');
  const uploadDir = join(data, 'uploads');
  const password = 'synthetic-password-123';
  const totpSecret = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';
  const defaultTenant = 'MASCLI/PRJ-SECHURA';
  const otherTenant = 'ACME/PRJ-NORTE';
  const otherDigest = scopeDirectory(otherTenant);
  await mkdir(tenantDir, { recursive: true });
  await mkdir(join(uploadDir, otherDigest), { recursive: true });
  await mkdir(join(tenantDir, `${otherDigest}_settings`), { recursive: true });

  // ---- auth_global.db ----------------------------------------------------
  const auth = new DatabaseSync(join(data, 'auth_global.db'));
  exec(auth, [
    legacyTable('auth_users'),
    legacyTable('auth_sessions'),
    legacyTable('tenant_projects'),
    legacyTable('access_grants'),
  ]);
  const hash = legacyPasswordHash(password);
  auth
    .prepare(
      'INSERT INTO auth_users(username,full_name,password_hash,role,active,created_at,totp_secret,totp_enabled) VALUES(?,?,?,?,?,?,?,?)',
    )
    .run('legacy.admin', 'Admin Sintetico', hash, 'admin', 1, now, null, 0);
  auth
    .prepare(
      'INSERT INTO auth_users(username,full_name,password_hash,role,active,created_at,totp_secret,totp_enabled) VALUES(?,?,?,?,?,?,?,?)',
    )
    .run('legacy.analyst', 'Analista Sintetico', hash, 'analista', 1, now, totpSecret, 1);
  // Rejected on purpose: unknown role (the report must flag it, nothing is written).
  auth
    .prepare(
      'INSERT INTO auth_users(username,full_name,password_hash,role,active,created_at,totp_secret,totp_enabled) VALUES(?,?,?,?,?,?,?,?)',
    )
    .run('legacy.ghost', 'Rol Invalido', hash, 'superadmin', 1, now, null, 0);
  auth
    .prepare('INSERT INTO auth_sessions(token_hash,username,expires_at,created_at) VALUES(?,?,?,?)')
    .run('f'.repeat(64), 'legacy.admin', 4_102_444_800, now);
  const project = auth.prepare('INSERT INTO tenant_projects VALUES(?,?,?)');
  project.run('MASCLI', 'PRJ-SECHURA', 'Proyecto Sechura (migración)');
  project.run('ACME', 'PRJ-NORTE', 'Proyecto Norte sintético');
  const grant = auth.prepare('INSERT INTO access_grants VALUES(?,?,?)');
  grant.run('legacy.admin', 'MASCLI', 'PRJ-SECHURA');
  grant.run('legacy.analyst', 'MASCLI', 'PRJ-SECHURA');
  grant.run('legacy.admin', 'ACME', 'PRJ-NORTE');
  // Rejected on purpose: grant for an account that does not exist.
  grant.run('legacy.missing', 'MASCLI', 'PRJ-NORTE');
  auth.close();

  // ---- tenant databases --------------------------------------------------
  const attachmentBytes = new Uint8Array(Buffer.from('EVIDENCIA-SINTETICA-0001\n', 'utf8'));
  const attachmentId = 'ADJ-0000000000A1';
  const otherAttachmentId = 'ADJ-0000000000B2';
  const eventId = 'EV-SYN-0001';
  const otherEventId = 'EV-SYN-9001';
  const storedName = `${randomUUID().replaceAll('-', '')}_evidencia.txt`;
  const otherStoredName = `${randomUUID().replaceAll('-', '')}_norte.txt`;
  const alertSha = createHash('sha256').update('alerta sintetica').digest('hex');
  const sourceSha = createHash('sha256').update('documento sintetico').digest('hex');

  const buildTenantDb = (path: string) => {
    const db = new DatabaseSync(path);
    exec(db, [
      legacyTable('records'),
      legacyTable('audit'),
      legacyTable('irsa_snapshots'),
      legacyTable('attachments'),
      legacyTable('document_review'),
      legacyTable('digital_alert_reviews'),
      legacyTable('preventive_actions'),
      legacyTable('preventive_action_log'),
    ]);
    return db;
  };

  const seedCommon = (db: DatabaseSync, tenant: 'default' | 'other') => {
    const insertRecord = db.prepare('INSERT INTO records VALUES(?,?,?,?,?)');
    const id = tenant === 'default' ? eventId : otherEventId;
    const projectId = tenant === 'default' ? 'PRJ-SECHURA' : 'PRJ-NORTE';
    insertRecord.run(
      'Eventos',
      id,
      JSON.stringify({
        ID_Evento: id,
        Titulo: tenant === 'default' ? 'Reunion sintetica sur' : 'Reunion sintetica norte',
        Estado: 'Abierta',
        Dimension: 'G - Gobernanza',
        Proyecto_ID: projectId,
        Detalle_Secreto: `MARCADOR-${tenant.toUpperCase()}-CONTENIDO`,
      }),
      now,
      now,
    );
    insertRecord.run(
      'Actores',
      `A-${tenant === 'default' ? 'SYN-01' : 'SYN-91'}`,
      JSON.stringify({
        ID_Actor: `A-${tenant === 'default' ? 'SYN-01' : 'SYN-91'}`,
        Nombre: 'Actor sintetico',
        Proyecto_ID: projectId,
      }),
      now,
      now,
    );
    db.prepare('INSERT INTO audit(ts,module,record_id,action,detail) VALUES(?,?,?,?,?)').run(
      now,
      'Eventos',
      id,
      'CREATE',
      'Registro sintetico creado',
    );
    db.prepare(
      'INSERT INTO irsa_snapshots(ts,irsa,level,scores,config_version,note) VALUES(?,?,?,?,?,?)',
    ).run(now, 42.5, 'Amarillo', JSON.stringify({ G: 40, A: 45 }), '0.4-indicators', 'sintetico');
    return id;
  };

  const defaultDb = buildTenantDb(join(data, 'mascli.db'));
  seedCommon(defaultDb, 'default');
  // Rejected on purpose: payload is not valid JSON.
  defaultDb
    .prepare('INSERT INTO records VALUES(?,?,?,?,?)')
    .run('Eventos', 'EV-BROKEN', '{not json', now, now);
  defaultDb
    .prepare(
      'INSERT INTO attachments(id,stored_name,original_name,content_type,size_bytes,sha256,linked_module,linked_record_id,document_type,author,verification,notes,project_id,project_name,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
    )
    .run(
      attachmentId,
      storedName,
      'evidencia.txt',
      'text/plain',
      attachmentBytes.length,
      createHash('sha256').update(attachmentBytes).digest('hex'),
      'eventos',
      eventId,
      'Reporte / evidencia',
      'Equipo sintetico',
      'E - No verificada',
      'nota sintetica',
      'PRJ-SECHURA',
      'Proyecto Sechura',
      now,
    );
  // Rejected on purpose: the file is gone from the upload root.
  defaultDb
    .prepare(
      'INSERT INTO attachments(id,stored_name,original_name,content_type,size_bytes,sha256,linked_module,linked_record_id,document_type,author,verification,notes,project_id,project_name,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
    )
    .run(
      'ADJ-0000000000C3',
      'perdido_archivo.txt',
      'perdido.txt',
      'text/plain',
      12,
      null,
      'eventos',
      eventId,
      'Reporte / evidencia',
      '',
      'E - No verificada',
      '',
      'PRJ-SECHURA',
      'Proyecto Sechura',
      now,
    );
  defaultDb
    .prepare(
      'INSERT INTO document_review(id,project_id,source_file,source_sha256,location,theme,excerpt,action,status,reviewer,note,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)',
    )
    .run(
      'DOC-SYN-1',
      'PRJ-SECHURA',
      'informe.pdf',
      sourceSha,
      'p. 3',
      'Compromisos',
      'MARCADOR-EXTRACTO-DOCUMENTAL',
      'Contrastar con acta',
      'pendiente',
      '',
      '',
      now,
      now,
    );
  defaultDb
    .prepare('INSERT INTO digital_alert_reviews VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
    .run(
      'DIG-SYN0001',
      'PRJ-SECHURA',
      now,
      'https://example.test/nota',
      'Publicación digital',
      'MARCADOR-EXTRACTO-DIGITAL',
      alertSha,
      'Media',
      45,
      'reglas',
      JSON.stringify([{ tema: 'agua', peso: 2 }]),
      JSON.stringify(['protesta']),
      JSON.stringify(['verificar en campo']),
      0,
      'Corroborado',
      'nota del analista',
      null,
      null,
    );
  defaultDb
    .prepare('INSERT INTO preventive_actions VALUES(?,?,?,?,?,?,?,?,?,?,?)')
    .run(
      'ACC-SYN-1',
      'PRJ-SECHURA',
      'DIG-SYN0001',
      'Plan sintetico de respuesta',
      'Coordinacion territorial',
      '2026-11-15',
      'descripcion sintetica',
      'En ejecución',
      40,
      now,
      now,
    );
  defaultDb
    .prepare('INSERT INTO preventive_action_log VALUES(?,?,?,?,?,?,?)')
    .run('LOG-SYN-1', 'ACC-SYN-1', now, 'En ejecución', 40, 'avance sintetico', null);
  defaultDb.close();

  const otherDb = buildTenantDb(join(tenantDir, `${otherDigest}.db`));
  seedCommon(otherDb, 'other');
  otherDb
    .prepare(
      'INSERT INTO attachments(id,stored_name,original_name,content_type,size_bytes,sha256,linked_module,linked_record_id,document_type,author,verification,notes,project_id,project_name,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
    )
    .run(
      otherAttachmentId,
      otherStoredName,
      'norte.txt',
      'text/plain',
      attachmentBytes.length,
      createHash('sha256').update(attachmentBytes).digest('hex'),
      'eventos',
      otherEventId,
      'Reporte / evidencia',
      '',
      'E - No verificada',
      '',
      'PRJ-NORTE',
      'Proyecto Norte',
      now,
    );
  otherDb.close();

  // ---- uploads and JSON configuration ------------------------------------
  await writeFile(join(uploadDir, storedName), attachmentBytes);
  await writeFile(join(uploadDir, otherDigest, otherStoredName), attachmentBytes);
  const irsaConfig = {
    version: '0.4-sintetica',
    weights: { G: 0.2, A: 0.2, D: 0.2, N: 0.15, E: 0.15, I: 0.1 },
    thresholds: { Verde: [0, 25], Amarillo: [25, 50], Naranja: [50, 75], Rojo: [75, 100] },
    contributions: { active_alert: 10 },
  };
  await writeFile(join(data, 'irsa_config.json'), JSON.stringify(irsaConfig), 'utf8');
  await writeFile(
    join(tenantDir, `${otherDigest}_settings`, 'irsa_config.json'),
    JSON.stringify({ ...irsaConfig, version: '0.4-sintetica-norte' }),
    'utf8',
  );

  return {
    root,
    cleanup: () => rm(root, { recursive: true, force: true }),
    password,
    adminUser: 'legacy.admin',
    analystUser: 'legacy.analyst',
    totpSecret,
    defaultTenant,
    otherTenant,
    attachmentBytes,
    attachmentId,
    otherAttachmentId,
    eventId,
    otherEventId,
    secrets: [
      hash,
      totpSecret,
      'MARCADOR-DEFAULT-CONTENIDO',
      'MARCADOR-OTHER-CONTENIDO',
      'MARCADOR-EXTRACTO-DOCUMENTAL',
      'MARCADOR-EXTRACTO-DIGITAL',
    ],
  };
};
