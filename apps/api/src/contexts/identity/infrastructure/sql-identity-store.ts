import type { SqlClient } from '../../../platform/database/sql-client.ts';
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
});

export const createSqlIdentityStore = (sql: SqlClient): IdentityStore => ({
  async hasUsers() {
    return (await sql.query('SELECT 1 FROM users LIMIT 1')).length > 0;
  },

  async findUser(username) {
    const [row] = await sql.query<UserRow>(
      `SELECT username, full_name, password_hash, role, active, totp_secret_sealed, totp_enabled, totp_last_step
         FROM users WHERE username = $1`,
      [username],
    );
    return row ? toUser(row) : null;
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
    }>(
      'SELECT username, full_name, role, active, created_at FROM users ORDER BY created_at, username',
    );
    return rows.map((r): AccountSummary => ({
      username: r.username,
      fullName: r.full_name,
      role: r.role,
      active: r.active,
      createdAt: new Date(r.created_at),
    }));
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

  async createSession(tokenHash, username, expiresAt, at) {
    await sql.query(
      'INSERT INTO sessions (token_hash, username, expires_at, created_at) VALUES ($1, $2, $3, $4)',
      [tokenHash, username, expiresAt, at],
    );
  },

  async findSessionIdentity(tokenHash, at) {
    const [row] = await sql.query<{ username: string; full_name: string; role: Role }>(
      `SELECT u.username, u.full_name, u.role
         FROM sessions s JOIN users u ON u.username = s.username
        WHERE s.token_hash = $1 AND s.expires_at > $2 AND u.active`,
      [tokenHash, at],
    );
    return row ? { username: row.username, fullName: row.full_name, role: row.role } : null;
  },

  async deleteSession(tokenHash) {
    await sql.query('DELETE FROM sessions WHERE token_hash = $1', [tokenHash]);
  },

  async purgeExpiredSessions(at) {
    await sql.query('DELETE FROM sessions WHERE expires_at <= $1', [at]);
  },

  async countFailures(subject, since) {
    const [row] = await sql.query<{ n: number | string }>(
      'SELECT count(*) AS n FROM login_failures WHERE subject = $1 AND failed_at > $2',
      [subject, since],
    );
    return Number(row?.n ?? 0);
  },

  async recordFailures(subjects, at) {
    await sql.query(
      'INSERT INTO login_failures (subject, failed_at) SELECT unnest($1::text[]), $2',
      [[...subjects], at],
    );
  },

  async clearFailures(subject) {
    await sql.query('DELETE FROM login_failures WHERE subject = $1', [subject]);
  },
});
