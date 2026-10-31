timeout --kill-after=15s 900s pnpm --filter @mascli/e2e exec playwright test --config playwright.webkit.config.ts --reporter=list,json
