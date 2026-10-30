timeout 120s bash -c "pnpm --filter @mascli/web build && pnpm --filter @mascli/e2e exec playwright test tests/09-ontology-intelligence.spec.ts --project=chromium"
