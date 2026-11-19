/**
 * Pooled mode: with SIPGES_PARITY_POOLER_ADDR (host:port of a transaction-mode PgBouncer in front
 * of the same server, scripts/agents/test-pgbouncer.sh addr), both APIs reach the database through
 * it, as production does through Cloudflare Hyperdrive or PlanetScale's pooler. The runner's own
 * fixtures and ledger keep the direct connection. Without it the URL is unchanged.
 */
export const throughPooler = (url: string, addr: string | undefined): string => {
  if (!addr) return url;
  if (!/^[^\s/:@]+:\d+$/.test(addr)) {
    throw new Error('SIPGES_PARITY_POOLER_ADDR must be host:port');
  }
  const parsed = new URL(url);
  parsed.host = addr;
  return parsed.toString();
};
