// Writes wrangler.go.deploy.jsonc: wrangler.go.jsonc plus the Hyperdrive of the trial's Neon
// branch and the trial Worker's public host. Wrangler has no flag or variable for a binding id,
// and a committed id or host would be a value nobody chose (docs/deployment/go-trial-runbook.md).
// Needs SIPGES_GO_HYPERDRIVE_ID, SIPGES_GO_PUBLIC_HOST and SIPGES_HYPERDRIVE_ID, the production
// Hyperdrive, which the trial must never use: without it the guard could not run, so the command
// refuses to start. Node must run TypeScript natively (22.18+).
// Usage: node go-trial-config.mjs [--out <file>]
import { readFileSync, writeFileSync } from 'node:fs';
import { HYPERDRIVE_ID, parseArgs, parseJsonc, readDeployValues } from './deploy-config.mjs';
import { renderGoConfig } from './src/go-trial-config.ts';

const HOST = /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/;

/** SIPGES_HYPERDRIVE_ID, validated like the deploy does; the production host is not needed here. */
const requiredProductionId = (env) =>
  readDeployValues({ SIPGES_PUBLIC_HOST: 'unused.invalid', [HYPERDRIVE_ID]: env[HYPERDRIVE_ID] })
    .hyperdriveId;

const local = (name) => new URL(name, import.meta.url);
const USAGE = 'Usage: node go-trial-config.mjs [--out <file>]';

try {
  const out = parseArgs(process.argv.slice(2), USAGE).out ?? local('wrangler.go.deploy.jsonc');
  const host = process.env.SIPGES_GO_PUBLIC_HOST?.trim();
  if (!host || !HOST.test(host))
    throw new Error(
      "SIPGES_GO_PUBLIC_HOST must be the trial Worker's bare host name, such as sipges-go.example.workers.dev",
    );
  const goText = readFileSync(local('wrangler.go.jsonc'), 'utf8');
  const go = parseJsonc(goText);
  go.vars = { ...go.vars, SIPGES_ALLOWED_HOSTS: host };
  // Production's id is only needed to be refused, so it comes from the variable the deploy uses.
  const production = parseJsonc(readFileSync(local('wrangler.jsonc'), 'utf8'));
  production.hyperdrive = production.hyperdrive.map((binding) => ({
    ...binding,
    id: requiredProductionId(process.env),
  }));
  writeFileSync(
    out,
    renderGoConfig(
      JSON.stringify(go),
      JSON.stringify(production),
      process.env.SIPGES_GO_HYPERDRIVE_ID,
    ),
  );
  console.log('Wrote wrangler.go.deploy.jsonc');
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
