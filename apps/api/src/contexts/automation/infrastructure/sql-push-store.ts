import type { SqlClient } from '../../../platform/database/sql-client.ts';
import type { PushPayload, PushStore } from '../application/ports.ts';

// Owner-scoped transaction: identity tables are global, outbox retains forced tenant RLS. Forced
// RLS does not bind a login that bypasses it, so each statement names the tenant too.
const withTenant = <T>(sql: SqlClient, tenantId: string, fn: (tx: SqlClient) => Promise<T>) =>
  sql.transaction(async (tx) => {
    await tx.query("SELECT set_config('app.tenant_id',$1,true)", [tenantId]);
    return fn(tx);
  });
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
  ownTargets: (username) =>
    sql.query(
      `SELECT s.endpoint,s.p256dh,s.auth FROM push_subscriptions s JOIN users u ON u.username=s.username AND u.active WHERE s.username=$1`,
      [username],
    ),
  enqueue: (tenantId, notificationId, restricted, payload, at) =>
    withTenant(sql, tenantId, async (tx) => {
      await tx.query(
        `INSERT INTO push_deliveries(tenant_id,notification_id,endpoint,username,restricted,payload,next_attempt_at)
 SELECT $1,$2,s.endpoint,s.username,$3,$4::jsonb,$5 FROM push_subscriptions s JOIN users u ON u.username=s.username AND u.active JOIN grants g ON g.username=s.username AND g.tenant_id=$1 WHERE NOT $3::boolean OR u.role<>'consulta' ON CONFLICT(notification_id,endpoint) DO NOTHING`,
        [tenantId, notificationId, restricted, JSON.stringify(payload), at],
      );
    }),
  claim: (tenantId, at, leaseUntil) =>
    withTenant(sql, tenantId, async (tx) => {
      const rows = await tx.query<{
        id: number;
        endpoint: string;
        p256dh: string;
        auth: string;
        payload: PushPayload;
        attempts: number;
      }>(
        `WITH due AS(
 SELECT d.id FROM push_deliveries d JOIN push_subscriptions s ON s.endpoint=d.endpoint AND s.username=d.username JOIN users u ON u.username=d.username AND u.active JOIN grants g ON g.username=d.username AND g.tenant_id=d.tenant_id
 WHERE d.tenant_id=$3 AND d.status='pending' AND d.next_attempt_at<=$1 AND(NOT d.restricted OR u.role<>'consulta') ORDER BY d.id LIMIT 1 FOR UPDATE OF d SKIP LOCKED
 ),claimed AS(UPDATE push_deliveries d SET attempts=d.attempts+1,next_attempt_at=$2 FROM due WHERE d.id=due.id AND d.tenant_id=$3 RETURNING d.*)
 SELECT c.id,s.endpoint,s.p256dh,s.auth,c.payload,c.attempts FROM claimed c JOIN push_subscriptions s ON s.endpoint=c.endpoint AND s.username=c.username`,
        [at, leaseUntil, tenantId],
      );
      return rows.map((r) => ({
        id: Number(r.id),
        subscription: { endpoint: r.endpoint, p256dh: r.p256dh, auth: r.auth },
        payload: r.payload,
        attempts: Number(r.attempts),
      }));
    }),
  finish: (tenantId, id, status, error, retryAt) =>
    withTenant(sql, tenantId, async (tx) => {
      await tx.query(
        'UPDATE push_deliveries SET status=$2,last_error=$3,next_attempt_at=$4 WHERE id=$1 AND tenant_id=$5',
        [id, status, error, retryAt, tenantId],
      );
    }),
  forget: async (endpoint) => {
    await sql.query('DELETE FROM push_subscriptions WHERE endpoint = $1', [endpoint]);
  },
});
