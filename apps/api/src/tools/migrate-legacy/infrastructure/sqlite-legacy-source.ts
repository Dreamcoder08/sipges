/**
 * Read-only adapter over a legacy MASCLI installation: SQLite databases (opened with
 * `node:sqlite` in read-only mode), the JSON settings files and the upload directory.
 * Nothing here writes to the legacy installation.
 */
import { readFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { isAbsolute, join, resolve, sep } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { LegacyRow, LegacyScope } from '../domain/legacy.ts';
import { scopeDigest } from '../domain/mapping.ts';
import type { LegacyGrantRow, LegacySource, LegacyTenantReader } from '../application/ports.ts';

/** Default scope of a legacy installation (app.py:61, :444). */
export const DEFAULT_SCOPE = { companyId: 'MASCLI', projectId: 'PRJ-SECHURA' } as const;

export type LegacyLayout = {
  /** `auth_global.db` (MASCLI_AUTH_DB_PATH). */
  readonly authDb: string;
  /** Default tenant database (MASCLI_DB_PATH). */
  readonly defaultDb: string;
  /** Directory of non-default tenant databases and their copied settings (MASCLI_TENANT_DIR). */
  readonly tenantDir: string;
  /** Upload root (MASCLI_UPLOAD_DIR). */
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
    defaultDb: overrides.defaultDb ?? join(data, 'mascli.db'),
    tenantDir: overrides.tenantDir ?? join(data, 'tenants'),
    uploadDir: overrides.uploadDir ?? join(data, 'uploads'),
    configDir: overrides.configDir ?? data,
  };
};

const openReadOnly = (path: string) => new DatabaseSync(path, { readOnly: true });

const tableExists = (db: DatabaseSync, table: string): boolean =>
  db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table) !==
  undefined;

/** Lazily created tables (document_review, RC 2.6/2.7) are simply absent in older installs. */
const selectAll = (db: DatabaseSync, table: string, orderBy = 'rowid'): readonly LegacyRow[] =>
  tableExists(db, table)
    ? (db.prepare(`SELECT * FROM ${table} ORDER BY ${orderBy}`).all() as unknown as LegacyRow[])
    : [];

const isDefaultScope = (scope: LegacyScope) =>
  scope.companyId === DEFAULT_SCOPE.companyId && scope.projectId === DEFAULT_SCOPE.projectId;

/** app.py:62 and :459-467: non-default scopes live in their own file, folder and upload root. */
export const tenantPaths = (layout: LegacyLayout, scope: LegacyScope) => {
  if (isDefaultScope(scope)) {
    return {
      db: layout.defaultDb,
      uploadRoot: layout.uploadDir,
      irsaConfig: join(layout.configDir, 'irsa_config.json'),
    };
  }
  const digest = scopeDigest(`${scope.companyId}/${scope.projectId}`);
  return {
    db: join(layout.tenantDir, `${digest}.db`),
    uploadRoot: join(layout.uploadDir, digest),
    irsaConfig: join(layout.tenantDir, `${digest}_settings`, 'irsa_config.json'),
  };
};

const EMPTY: readonly LegacyRow[] = [];

const missingTenantReader = (scope: LegacyScope, tenantId: string): LegacyTenantReader => ({
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
  irsaConfig: () => Promise.resolve(null),
  readObject: () => Promise.resolve(null),
  close: () => Promise.resolve(),
});

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
      if (!existsSync(paths.db)) return Promise.resolve(missingTenantReader(scope, tenantId));
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
        irsaConfig: () => readJsonObject(paths.irsaConfig),
        readObject: async (storedName) => {
          // Stored names come from the legacy database; never let one escape the upload root.
          if (!storedName || isAbsolute(storedName) || storedName.includes('\u0000')) return null;
          const path = resolve(join(uploadRoot, storedName));
          if (path !== uploadRoot && !path.startsWith(uploadRoot + sep)) return null;
          try {
            const info = await stat(path);
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
