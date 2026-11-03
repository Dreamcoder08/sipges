import { appendAudit } from '../../../platform/database/audit-trail.ts';
import type { SqlClient } from '../../../platform/database/sql-client.ts';
import { enterTenant } from '../../../platform/database/tenant-transaction.ts';

const USER_COLUMNS =
  'username, full_name, password_hash, role, active, totp_secret_sealed, totp_enabled, totp_last_step, google_email';
import type { AccountSummary, IdentityStore, StoredUser } from '../application/ports.ts';
import type { Role } from '../domain/user.ts';

type UserRow = {
  username: string;
  full_name: string;
  password_hash: string;
  role: Role;
  active: boolean;
  totp_secret_sealed: string | null;
  totp_enabled: boolean;
  totp_last_step: string | number | null;
  google_email: string | null;
};

const toUser = (row: UserRow): StoredUser => ({
  username: row.username,
  fullName: row.full_name,
  passwordHash: row.password_hash,
  role: row.role,
  active: row.active,
  totpSecretSealed: row.totp_secret_sealed,
  totpEnabled: row.totp_enabled,
  totpLastStep: row.totp_last_step === null ? null : Number(row.totp_last_step),
  googleEmail: row.google_email,
});

/** Clears the second factor (enabled flag, sealed or pending secret, last step) and every session. */
const clearTotp = async (tx: SqlClient, username: string): Promise<'reset' | 'missing'> => {
  const rows = await tx.query(
    `UPDATE users SET totp_enabled = false, totp_secret_sealed = NULL, totp_last_step = NULL
      WHERE username = $1 RETURNING username`,
    [username],
  );
  if (rows.length === 0) return 'missing';
  await tx.query('DELETE FROM sessions WHERE username = $1', [username]);
  return 'reset';
};

export const createSqlIdentityStore = (sql: SqlClient): IdentityStore => ({
  async hasUsers() {
    return (await sql.query('SELECT 1 FROM users LIMIT 1')).length > 0;
  },

  async findUser(username) {
    const [row] = await sql.query<UserRow>(
      `SELECT ${USER_COLUMNS} FROM users WHERE username = $1`,
      [username],
    );
    return row ? toUser(row) : null;
  },

  async findUserByGoogleEmail(email) {
    const [row] = await sql.query<UserRow>(
      `SELECT ${USER_COLUMNS} FROM users WHERE google_email = $1`,
      [email],
    );
    return row ? toUser(row) : null;
  },

  async setGoogleEmail(username, email) {
    return sql.transaction(async (tx) => {
      const [user] = await tx.query<{ google_email: string | null }>(
        'SELECT google_email FROM users WHERE username = $1 FOR UPDATE',
        [username],
      );
      if (!user) return 'missing';
      if (email !== null) {
        const taken = await tx.query(
          'SELECT 1 FROM users WHERE google_email = $1 AND username <> $2',
          [email, username],
        );
        if (taken.length > 0) return 'taken';
      }
      if (user.google_email === email) return 'set';
      await tx.query('UPDATE users SET google_email = $2 WHERE username = $1', [username, email]);
      // Sessions opened with the previous address must not outlive the link that allowed them.
      await tx.query('DELETE FROM sessions WHERE username = $1 AND via_google', [username]);
      return 'set';
    });
  },

  async linkBootstrapGoogleEmail(username, email) {
    // A single conditional UPDATE: under concurrent writers PostgreSQL re-checks
    // `google_email IS NULL` on the latest row version, so a link committed meanwhile wins.
    try {
      const [row] = await sql.query<{ linked: boolean; taken: boolean }>(
        `WITH linked AS (
           UPDATE users SET google_email = $2::text
            WHERE username = $1::text AND role = 'admin' AND google_email IS NULL
              AND NOT EXISTS (SELECT 1 FROM users WHERE google_email = $2::text)
           RETURNING 1)
         SELECT EXISTS (SELECT 1 FROM linked) AS linked,
                -- Only an administrator still waiting for an address reports the conflict, so
                -- cold starts stay quiet once an administrator linked a different one.
                EXISTS (SELECT 1 FROM users
                         WHERE username = $1::text AND role = 'admin' AND google_email IS NULL)
                AND EXISTS (SELECT 1 FROM users
                             WHERE google_email = $2::text AND username <> $1::text) AS taken`,
        [username, email],
      );
      if (row?.linked) return 'linked';
      return row?.taken ? 'taken' : 'kept';
    } catch (error) {
      // Another account took the address between the snapshot and the unique index check.
      if ((error as { code?: unknown } | null)?.code === '23505') return 'taken';
      throw error;
    }
  },

  async createUser(account, at) {
    const rows = await sql.query(
      `INSERT INTO users (username, full_name, password_hash, role, created_at)
       VALUES ($1, $2, $3, $4, $5) ON CONFLICT (username) DO NOTHING RETURNING username`,
      [account.username, account.fullName, account.passwordHash, account.role, at],
    );
    return rows.length === 1;
  },

  async listAccounts() {
    const rows = await sql.query<{
      username: string;
      full_name: string;
      role: Role;
      active: boolean;
      created_at: Date;
      google_email: string | null;
    }>(
      'SELECT username, full_name, role, active, created_at, google_email FROM users ORDER BY created_at, username',
    );
    return rows.map((r): AccountSummary => ({
      username: r.username,
      fullName: r.full_name,
      role: r.role,
      active: r.active,
      createdAt: new Date(r.created_at),
      googleEmail: r.google_email,
    }));
  },

  async deactivateUser(username) {
    return sql.transaction(async (tx) => {
      await tx.query(
        "SELECT pg_advisory_xact_lock(hashtextextended('sipges:account-deactivation', 0))",
      );
      const [user] = await tx.query<{ role: Role; active: boolean }>(
        'SELECT role, active FROM users WHERE username = $1 FOR UPDATE',
        [username],
      );
      if (!user) return 'missing';
      if (user.active && user.role === 'admin') {
        const [count] = await tx.query<{ n: string | number }>(
          "SELECT count(*) AS n FROM users WHERE active AND role = 'admin'",
        );
        if (Number(count?.n) <= 1) return 'last_admin';
      }
      await tx.query('UPDATE users SET active = false WHERE username = $1', [username]);
      await tx.query('DELETE FROM sessions WHERE username = $1', [username]);
      return 'deactivated';
    });
  },

  async updatePasswordHash(username, passwordHash) {
    await sql.query('UPDATE users SET password_hash = $2 WHERE username = $1', [
      username,
      passwordHash,
    ]);
  },

  async startTotpEnrollment(username, sealedSecret) {
    const rows = await sql.query(
      `UPDATE users SET totp_secret_sealed = $2, totp_last_step = NULL
        WHERE username = $1 AND totp_enabled = false RETURNING username`,
      [username, sealedSecret],
    );
    return rows.length === 1;
  },

  async resetTotp(username) {
    return sql.transaction((tx) => clearTotp(tx, username));
  },

  async resetTotpInTenant(username, tenantId, audit) {
    return sql.transaction(async (tx) => {
      const users = await tx.query('SELECT 1 FROM users WHERE username = $1 FOR UPDATE', [
        username,
      ]);
      if (users.length === 0) return 'missing';
      const granted = await tx.query(
        'SELECT 1 FROM grants WHERE username = $1 AND tenant_id = $2',
        [username, tenantId],
      );
      if (granted.length === 0) return 'out_of_scope';
      await clearTotp(tx, username);
      // Global writes first: entering the tenant drops to the role that cannot see them.
      await enterTenant(tx, tenantId);
      await appendAudit(tx, {
        module: 'Cuentas',
        recordId: username,
        action: 'MFA_RESET',
        detail: audit.detail,
        at: audit.at,
      });
      return 'reset';
    });
  },

  async enableTotp(username, step, keepTokenHash) {
    await sql.transaction(async (tx) => {
      await tx.query(
        'UPDATE users SET totp_enabled = true, totp_last_step = $2 WHERE username = $1',
        [username, step],
      );
      await tx.query('DELETE FROM sessions WHERE username = $1 AND token_hash <> $2', [
        username,
        keepTokenHash,
      ]);
    });
  },

  async consumeTotpStep(username, step) {
    const rows = await sql.query(
      `UPDATE users SET totp_last_step = $2
        WHERE username = $1 AND (totp_last_step IS NULL OR totp_last_step < $2) RETURNING username`,
      [username, step],
    );
    return rows.length === 1;
  },

  async createSession(tokenHash, username, expiresAt, at, options = {}) {
    return sql.transaction(async (tx) => {
      const users = await tx.query(
        'SELECT username FROM users WHERE username = $1 AND active FOR SHARE',
        [username],
      );
      if (users.length === 0) return false;
      await tx.query(
        `INSERT INTO sessions (token_hash, username, expires_at, created_at, via_google)
         VALUES ($1, $2, $3, $4, $5)`,
        [tokenHash, username, expiresAt, at, options.viaGoogle === true],
      );
      return true;
    });
  },

  async findSessionIdentity(tokenHash, at) {
    const [row] = await sql.query<{
      username: string;
      full_name: string;
      role: Role;
      totp_enabled: boolean;
      via_google: boolean;
    }>(
      `SELECT u.username, u.full_name, u.role, u.totp_enabled, s.via_google
         FROM sessions s JOIN users u ON u.username = s.username
        WHERE s.token_hash = $1::text AND s.expires_at > $2::timestamptz AND u.active`,
      [tokenHash, at],
    );
    return row
      ? {
          username: row.username,
          fullName: row.full_name,
          role: row.role,
          // Google sign-in stands in for the app's TOTP factor (ADR 0010).
          mfaEnabled: row.totp_enabled || row.via_google,
        }
      : null;
  },

  async deleteSession(tokenHash) {
    await sql.query('DELETE FROM sessions WHERE token_hash = $1', [tokenHash]);
  },

  async purgeExpiredSessions(at) {
    await sql.query('DELETE FROM sessions WHERE expires_at <= $1', [at]);
  },

  async reserveLoginAttempt({ userSubject, ipSubject, windowStart, at, decide }) {
    return sql.transaction(async (tx) => {
      // Transaction-scoped locks per subject, taken in a fixed order to avoid deadlocks.
      for (const subject of [userSubject, ipSubject].sort()) {
        await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [subject]);
      }
      await tx.query('DELETE FROM login_failures WHERE failed_at <= $1', [windowStart]);
      const rows = await tx.query<{ subject: string; n: number | string }>(
        `SELECT subject, count(*) AS n FROM login_failures
          WHERE subject = ANY($1::text[]) AND failed_at > $2 GROUP BY subject`,
        [[userSubject, ipSubject], windowStart],
      );
      const count = (subject: string) => Number(rows.find((r) => r.subject === subject)?.n ?? 0);
      const decision = decide({ userFailures: count(userSubject), ipFailures: count(ipSubject) });
      if (!decision.allowed) return { decision, reservation: [] };

      const inserted = await tx.query<{ id: number | string }>(
        'INSERT INTO login_failures (subject, failed_at) VALUES ($1, $3), ($2, $3) RETURNING id',
        [userSubject, ipSubject, at],
      );
      return { decision, reservation: inserted.map((r) => Number(r.id)) };
    });
  },

  async releaseLoginAttempt(reservation) {
    if (reservation.length === 0) return;
    await sql.query('DELETE FROM login_failures WHERE id = ANY($1::bigint[])', [[...reservation]]);
  },

  async clearFailures(subject) {
    await sql.query('DELETE FROM login_failures WHERE subject = $1', [subject]);
  },
});
