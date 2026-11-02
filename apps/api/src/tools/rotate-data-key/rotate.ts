/**
 * Re-encrypts every value sealed with the old SIPGES_DATA_KEY under the new one
 * (docs/operations/data-key-rotation.md, ADR 0004).
 *
 * - A read-only pass classifies every value first: `current` (opens with the new key), `stale`
 *   (opens with the old key) or `unreadable` (neither). One unreadable value anywhere stops the
 *   run before any write, so a wrong old key never half-rotates the database.
 * - `apply` then rewrites each unit (the global users table, then each tenant's channels) in its
 *   own transaction with the rows locked, checks every value opens with the new key before
 *   commit, and skips values that are already current: re-running is a no-op and an interrupted
 *   run resumes where it stopped.
 * - Reports hold counts and row identifiers only; plaintext and keys never leave this module.
 */
import { createSecretCipher } from '../../contexts/identity/infrastructure/secret-cipher.ts';
import type { SecretCipher } from '../../contexts/identity/application/ports.ts';
import type { SqlClient } from '../../platform/database/sql-client.ts';
import { withTenant } from '../../platform/database/tenant-transaction.ts';

export type RotationMode = 'dry-run' | 'apply';

export type ColumnReport = {
  readonly table: string;
  readonly column: string;
  /** 'global' for owner tables, otherwise the tenant id whose RLS scope was used. */
  readonly scope: string;
  readonly total: number;
  readonly current: number;
  readonly stale: number;
  readonly unreadable: number;
  readonly rewritten: number;
  /** Primary keys of the values neither key opens (usernames or channel ids). */
  readonly unreadableIds: readonly string[];
};

export type RotationReport = {
  readonly mode: RotationMode;
  readonly ok: boolean;
  readonly columns: readonly ColumnReport[];
  readonly problem?: string;
};

// Every column sealed with SIPGES_DATA_KEY. Identifiers are static code, never input. A new
// sealed column must be added here; a test fails when the schema has one this list lacks.
export const TARGETS = [
  { table: 'users', column: 'totp_secret_sealed', id: 'username', tenantOwned: false },
  { table: 'integration_channels', column: 'sealed_config', id: 'id', tenantOwned: true },
] as const;

type Target = (typeof TARGETS)[number];
type Unit = { readonly target: Target; readonly scope: string };
type Ciphers = { readonly fresh: SecretCipher; readonly old: SecretCipher };

const tryOpen = (cipher: SecretCipher, sealed: string): string | undefined => {
  try {
    return cipher.open(sealed);
  } catch {
    return undefined;
  }
};

const inUnit = <T>(sql: SqlClient, unit: Unit, fn: (tx: SqlClient) => Promise<T>) =>
  unit.target.tenantOwned ? withTenant(sql, unit.scope, fn) : sql.transaction(fn);

const selectSealed = (tx: SqlClient, target: Target, lock: boolean) =>
  tx.query<{ id: string | number; sealed: string }>(
    `SELECT ${target.id} AS id, ${target.column} AS sealed FROM ${target.table}
     WHERE ${target.column} IS NOT NULL ORDER BY ${target.id}${lock ? ' FOR UPDATE' : ''}`,
  );

/** Classifies one unit and, when `apply`, rewrites its stale values inside `tx`. */
const processUnit = async (
  tx: SqlClient,
  unit: Unit,
  ciphers: Ciphers,
  apply: boolean,
): Promise<ColumnReport> => {
  const { target } = unit;
  const rows = await selectSealed(tx, target, apply);
  let current = 0;
  let rewritten = 0;
  const stale: { id: string | number; sealed: string; plaintext: string }[] = [];
  const unreadableIds: string[] = [];
  for (const row of rows) {
    if (tryOpen(ciphers.fresh, row.sealed) !== undefined) {
      current += 1;
      continue;
    }
    const plaintext = tryOpen(ciphers.old, row.sealed);
    if (plaintext === undefined) unreadableIds.push(String(row.id));
    else stale.push({ ...row, plaintext });
  }

  if (apply) {
    // The preflight saw none; a value changed since then. Throwing rolls this unit back.
    if (unreadableIds.length > 0) {
      throw new Error(`${target.table}.${target.column} (${unit.scope}) has unreadable values`);
    }
    for (const value of stale) {
      const resealed = ciphers.fresh.seal(value.plaintext);
      if (tryOpen(ciphers.fresh, resealed) !== value.plaintext) {
        throw new Error(`Re-encryption check failed in ${target.table}.${target.column}`);
      }
      const updated = await tx.query(
        `UPDATE ${target.table} SET ${target.column} = $1
         WHERE ${target.id} = $2 AND ${target.column} = $3 RETURNING ${target.id}`,
        [resealed, value.id, value.sealed],
      );
      if (updated.length !== 1) {
        throw new Error(`${target.table}.${target.column} changed during rotation; re-run`);
      }
      rewritten += 1;
    }
    // Verification before commit: every value in the unit now opens with the new key.
    for (const row of await selectSealed(tx, target, false)) {
      if (tryOpen(ciphers.fresh, row.sealed) === undefined) {
        throw new Error(`${target.table}.${target.column} does not open with the new key`);
      }
    }
  }

  return {
    table: target.table,
    column: target.column,
    scope: unit.scope,
    total: rows.length,
    current,
    stale: stale.length,
    unreadable: unreadableIds.length,
    rewritten,
    unreadableIds,
  };
};

const listUnits = async (sql: SqlClient): Promise<Unit[]> => {
  const tenants = await sql.query<{ tenant_id: string }>(
    'SELECT tenant_id FROM tenants ORDER BY tenant_id',
  );
  return TARGETS.flatMap((target: Target): Unit[] =>
    target.tenantOwned
      ? tenants.map((tenant) => ({ target, scope: tenant.tenant_id }))
      : [{ target, scope: 'global' }],
  );
};

export const rotateDataKey = async (
  sql: SqlClient,
  options: { readonly oldKey: Buffer; readonly newKey: Buffer; readonly mode: RotationMode },
): Promise<RotationReport> => {
  if (options.oldKey.equals(options.newKey)) {
    throw new Error('The old and new data keys must differ');
  }
  const ciphers: Ciphers = {
    fresh: createSecretCipher(options.newKey),
    old: createSecretCipher(options.oldKey),
  };
  const units = await listUnits(sql);

  const preflight: ColumnReport[] = [];
  for (const unit of units) {
    preflight.push(await inUnit(sql, unit, (tx) => processUnit(tx, unit, ciphers, false)));
  }
  if (preflight.some((column) => column.unreadable > 0)) {
    return {
      mode: options.mode,
      ok: false,
      columns: preflight,
      problem:
        'Some values cannot be opened with either key (wrong SIPGES_DATA_KEY_PREVIOUS?); nothing was written',
    };
  }
  if (options.mode === 'dry-run') return { mode: 'dry-run', ok: true, columns: preflight };

  const applied: ColumnReport[] = [];
  for (const unit of units) {
    applied.push(await inUnit(sql, unit, (tx) => processUnit(tx, unit, ciphers, true)));
  }
  return { mode: 'apply', ok: true, columns: applied };
};

/** Human summary: counts and identifiers only. */
export const summarize = (report: RotationReport): string => {
  const lines = [`SIPGES_DATA_KEY rotation (${report.mode})`];
  for (const c of report.columns) {
    lines.push(
      `  ${c.table}.${c.column} [${c.scope}]: total ${c.total}, current ${c.current}, ` +
        `stale ${c.stale}, unreadable ${c.unreadable}, rewritten ${c.rewritten}` +
        (c.unreadableIds.length > 0 ? ` (unreadable: ${c.unreadableIds.join(', ')})` : ''),
    );
  }
  const stale = report.columns.reduce((sum, c) => sum + c.stale, 0);
  if (report.problem) lines.push(`ABORTED: ${report.problem}`);
  else if (report.mode === 'dry-run') {
    lines.push(
      stale > 0 ? `${stale} value(s) would be re-encrypted; run with --apply` : 'Nothing to rotate',
    );
  } else lines.push('Done: every sealed value opens with the new key');
  return lines.join('\n');
};
