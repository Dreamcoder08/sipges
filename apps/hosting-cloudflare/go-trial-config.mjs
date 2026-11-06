// Writes wrangler.go.deploy.jsonc: wrangler.go.jsonc plus the Hyperdrive of the trial's Neon
// branch. Wrangler has no flag or variable for a binding id, and a committed id would be a value
// nobody chose (docs/deployment/go-trial-runbook.md). Needs SIPGES_GO_HYPERDRIVE_ID.
// Node must run TypeScript natively (22.18+).
import { readFileSync, writeFileSync } from 'node:fs';
import { renderGoConfig } from './src/go-trial-config.ts';

const local = (name) => new URL(name, import.meta.url);

try {
  writeFileSync(
    local('wrangler.go.deploy.jsonc'),
    renderGoConfig(
      readFileSync(local('wrangler.go.jsonc'), 'utf8'),
      readFileSync(local('wrangler.jsonc'), 'utf8'),
      process.env.SIPGES_GO_HYPERDRIVE_ID,
    ),
  );
  console.log('Wrote wrangler.go.deploy.jsonc');
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
