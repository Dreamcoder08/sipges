/**
 * Read-only adapter over a legacy SIPGES installation: SQLite databases (opened with
 * `node:sqlite` in read-only mode), the JSON settings files and the upload directory.
 * Nothing here writes to the legacy installation.
 */
import { lstat, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { isAbsolute, join, resolve, sep } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { LegacyRow, LegacyScope, LegacyValue } from '../domain/legacy.ts';
import { legacyStoredNameSafe, scopeDigest } from '../domain/mapping.ts';
import type { LegacyGrantRow, LegacySource, LegacyTenantReader } from '../application/ports.ts';

/** Default scope of a legacy installation (app.py:61, :444). */
export const DEFAULT_SCOPE = { companyId: 'SIPGES', projectId: 'PRJ-SECHURA' } as const;

export type LegacyLayout = {
  /** `auth_global.db` (SIPGES_AUTH_DB_PATH). */
  readonly authDb: string;
  /** Default tenant database (SIPGES_DB_PATH). */
  readonly defaultDb: string;
  /** Directory of non-default tenant databases and their copied settings (SIPGES_TENANT_DIR). */
  readonly tenantDir: string;
  /** Upload root (SIPGES_UPLOAD_DIR). */
  readonly uploadDir: string;
  /** Directory of the default scope's JSON configuration (`<root>/data`). */
  readonly configDir: string;
};

/** Mirrors app.py's path defaults relative to a legacy installation root. */
export const legacyLayout = (root: string, overrides: Partial<LegacyLayout> = {}): LegacyLayout => {
  const base = resolve(root);
  const data = join(base, 'data');
  return {
    authDb: overrides.authDb ?? join(data, 'auth_global.db'),
    defaultDb: overrides.defaultDb ?? join(data, 'sipges.db'),
    tenantDir: overrides.tenantDir ?? join(data, 'tenants'),
    uploadDir: overrides.uploadDir ?? join(data, 'uploads'),
    configDir: overrides.configDir ?? data,
  };
};

const openReadOnly = (path: string) => new DatabaseSync(path, { readOnly: true });

const tableExists = (db: DatabaseSync, table: string): boolean =>
  db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table) !==
  undefined;

/**
 * Lazily created tables (document_review, RC 2.6/2.7) are simply absent in older installs.
 *
 * Text comes through as bytes: Node 22's node:sqlite cuts a string at its first NUL, which would
 * let a value pass as a shorter one. Read whole, the mapping refuses it. `typeof` tells such a
 * cell from a real blob. The bytes are in the file's encoding, and decoding replaces invalid
 * sequences as node:sqlite does. `pragma_table_xinfo` lists what `SELECT *` returns, generated
 * columns included; hidden = 1 marks the hidden columns of a virtual table.
 */
const selectAll = (db: DatabaseSync, table: string, orderBy = 'rowid'): readonly LegacyRow[] => {
  if (!tableExists(db, table)) return [];
  const names = (
    db
      .prepare('SELECT name FROM pragma_table_xinfo(?) WHERE hidden <> 1')
      .all(table) as unknown as { name: string }[]
  ).map((column) => column.name);
  const { encoding } = db.prepare('PRAGMA encoding').get() as unknown as { encoding: string };
  const decoder = new TextDecoder(encoding.toLowerCase(), { ignoreBOM: true });
  const cells = names.flatMap((name, index) => {
    const column = `"${name.replaceAll('"', '""')}"`;
    return [
      `CASE typeof(${column}) WHEN 'text' THEN CAST(${column} AS BLOB) ELSE ${column} END AS v${index}`,
      `typeof(${column}) AS t${index}`,
    ];
  });
  const rows = db
    .prepare(`SELECT ${cells.join(', ')} FROM ${table} ORDER BY ${orderBy}`)
    .all() as unknown as Readonly<Record<string, LegacyValue>>[];
  return rows.map((row) =>
    Object.fromEntries(
      names.map((name, index) => {
        const value = row[`v${index}`];
        const text = row[`t${index}`] === 'text' && value instanceof Uint8Array;
        return [name, text ? decoder.decode(value) : value];
      }),
    ),
  );
};

const isDefaultScope = (scope: LegacyScope) =>
  scope.companyId === DEFAULT_SCOPE.companyId && scope.projectId === DEFAULT_SCOPE.projectId;

/** app.py:62 and :459-467: non-default scopes live in their own file, folder and upload root. */
export const tenantPaths = (layout: LegacyLayout, scope: LegacyScope) => {
  const defaultIrsaConfig = join(layout.configDir, 'irsa_config.json');
  if (isDefaultScope(scope)) {
    return {
      db: layout.defaultDb,
      uploadRoot: layout.uploadDir,
      irsaConfig: defaultIrsaConfig,
      defaultIrsaConfig,
    };
  }
  const digest = scopeDigest(`${scope.companyId}/${scope.projectId}`);
  return {
    db: join(layout.tenantDir, `${digest}.db`),
    uploadRoot: join(layout.uploadDir, digest),
    irsaConfig: join(layout.tenantDir, `${digest}_settings`, 'irsa_config.json'),
    defaultIrsaConfig,
  };
};

const readJsonObject = async (path: string) => {
  if (!existsSync(path)) return null;
  try {
    const parsed: unknown = JSON.parse(await readFile(path, 'utf8'));
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return 'invalid';
    return parsed as Record<string, unknown>;
  } catch {
    return 'invalid' as const;
  }
};

/**
 * app.py `scoped_config` copies the default scope's `data/irsa_config.json` into a tenant's
 * `_settings` folder on first use, so a tenant without its own file computes IRSA with the
 * default configuration. The migration carries that file over to keep results unchanged.
 */
const readIrsaConfig = async (paths: ReturnType<typeof tenantPaths>) => {
  if (existsSync(paths.irsaConfig) || paths.irsaConfig === paths.defaultIrsaConfig)
    return { config: await readJsonObject(paths.irsaConfig), inherited: false };
  const config = await readJsonObject(paths.defaultIrsaConfig);
  return { config, inherited: config !== null };
};

const EMPTY: readonly LegacyRow[] = [];

const missingTenantReader = (
  scope: LegacyScope,
  tenantId: string,
  paths: ReturnType<typeof tenantPaths>,
): LegacyTenantReader => ({
  scope,
  tenantId,
  present: false,
  records: () => Promise.resolve(EMPTY),
  audit: () => Promise.resolve(EMPTY),
  snapshots: () => Promise.resolve(EMPTY),
  attachments: () => Promise.resolve(EMPTY),
  documentReviews: () => Promise.resolve(EMPTY),
  alerts: () => Promise.resolve(EMPTY),
  actions: () => Promise.resolve(EMPTY),
  actionLog: () => Promise.resolve(EMPTY),
  irsaConfig: () => readIrsaConfig(paths),
  readObject: () => Promise.resolve(null),
  close: () => Promise.resolve(),
});

/** The source owns the auth database handle; `close` releases it. */
export type ClosableLegacySource = LegacySource & { readonly close: () => void };

export const createSqliteLegacySource = (layout: LegacyLayout): ClosableLegacySource => {
  if (!existsSync(layout.authDb))
    throw new Error(`Legacy auth database not found: ${layout.authDb}`);
  const auth = openReadOnly(layout.authDb);
  const authRows = (table: string, orderBy: string) => selectAll(auth, table, orderBy);

  return {
    close: () => auth.close(),

    scopes: () =>
      Promise.resolve(
        authRows('tenant_projects', 'company_id, project_id').map((row): LegacyScope => ({
          companyId: String(row['company_id'] ?? ''),
          projectId: String(row['project_id'] ?? ''),
          label: String(row['label'] ?? ''),
        })),
      ),

    users: () => Promise.resolve(authRows('auth_users', 'username')),

    grants: () =>
      Promise.resolve(
        authRows('access_grants', 'username, company_id, project_id').map(
          (row): LegacyGrantRow => ({
            username: String(row['username'] ?? ''),
            scope: {
              companyId: String(row['company_id'] ?? ''),
              projectId: String(row['project_id'] ?? ''),
              label: '',
            },
          }),
        ),
      ),

    sessionCount: () => Promise.resolve(authRows('auth_sessions', 'token_hash').length),

    openTenant: (scope) => {
      const tenantId = `${scope.companyId}/${scope.projectId}`;
      const paths = tenantPaths(layout, scope);
      if (!existsSync(paths.db))
        return Promise.resolve(missingTenantReader(scope, tenantId, paths));
      const db = openReadOnly(paths.db);
      const uploadRoot = resolve(paths.uploadRoot);

      const reader: LegacyTenantReader = {
        scope,
        tenantId,
        present: true,
        records: () => Promise.resolve(selectAll(db, 'records', 'module, record_id')),
        audit: () => Promise.resolve(selectAll(db, 'audit', 'id')),
        snapshots: () => Promise.resolve(selectAll(db, 'irsa_snapshots', 'id')),
        attachments: () => Promise.resolve(selectAll(db, 'attachments', 'created_at, id')),
        documentReviews: () => Promise.resolve(selectAll(db, 'document_review', 'created_at, id')),
        alerts: () => Promise.resolve(selectAll(db, 'digital_alert_reviews', 'created_at, id')),
        actions: () => Promise.resolve(selectAll(db, 'preventive_actions', 'created_at, id')),
        actionLog: () => Promise.resolve(selectAll(db, 'preventive_action_log', 'created_at, id')),
        irsaConfig: () => readIrsaConfig(paths),
        readObject: async (storedName) => {
          // Stored names come from the legacy database; never let one escape the upload root.
          // The default scope's root also holds every other tenant's folder, so a name must be
          // a single path component (app.py writes `<uuid hex>_<safe name>`), and a symlink is
          // never followed.
          if (!legacyStoredNameSafe(storedName) || isAbsolute(storedName)) return null;
          const path = resolve(join(uploadRoot, storedName));
          if (!path.startsWith(uploadRoot + sep)) return null;
          try {
            const info = await lstat(path);
            if (!info.isFile()) return null;
            return new Uint8Array(await readFile(path));
          } catch {
            return null;
          }
        },
        close: () => {
          db.close();
          return Promise.resolve();
        },
      };
      return Promise.resolve(reader);
    },
  };
};
