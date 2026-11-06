timeout 120s bash -c "pnpm --filter @sipges/web build && pnpm --filter @sipges/e2e exec playwright test tests/09-ontology-intelligence.spec.ts --project=chromium"
