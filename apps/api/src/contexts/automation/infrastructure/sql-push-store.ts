import type { SqlClient } from '../../../platform/database/sql-client.ts';
import type { PushStore } from '../application/ports.ts';

/** push_subscriptions, users and grants are global tables reached with the owner connection. */
export const createSqlPushStore = (sql: SqlClient): PushStore => ({
  save: async (username, s, at) => {
    await sql.query(
      `INSERT INTO push_subscriptions (endpoint, username, p256dh, auth, created_at)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (endpoint) DO UPDATE
         SET username = EXCLUDED.username, p256dh = EXCLUDED.p256dh, auth = EXCLUDED.auth`,
      [s.endpoint, username, s.p256dh, s.auth, at],
    );
  },
  remove: async (username, endpoint) => {
    await sql.query('DELETE FROM push_subscriptions WHERE endpoint = $1 AND username = $2', [
      endpoint,
      username,
    ]);
  },
  targets: (tenantId, restricted) =>
    sql.query(
      `SELECT s.endpoint, s.p256dh, s.auth
       FROM push_subscriptions s
       JOIN users u ON u.username = s.username AND u.active
       JOIN grants g ON g.username = s.username AND g.tenant_id = $1
       WHERE NOT $2::boolean OR u.role <> 'consulta'
       ORDER BY s.created_at`,
      [tenantId, restricted],
    ),
  forget: async (endpoint) => {
    await sql.query('DELETE FROM push_subscriptions WHERE endpoint = $1', [endpoint]);
  },
});
