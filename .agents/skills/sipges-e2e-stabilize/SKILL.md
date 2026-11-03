---
name: sipges-e2e-stabilize
description: "Use when writing or fixing a SIPGES Playwright e2e test in apps/e2e, or when one is flaky, slow or differs between Chromium, mobile and WebKit. CI diagnosis itself belongs to sipges-ci-triage."
---

# Write and stabilize e2e tests

Suite: `apps/e2e` (Playwright, pinned in `apps/e2e/package.json`). Projects: `chromium` (desktop),
`mobile-chromium` (Pixel 7, `*.mobile.spec.ts`), and `webkit` through `playwright.webkit.config.ts`.
Run: `pnpm e2e` (builds the web app first), or
`pnpm --filter @sipges/e2e exec playwright test tests/<file> --project chromium`.

## Rules that fixed past flakes

1. **Wait for state, never read once or sleep.** Use web-first assertions (`await expect(locator)…`) or
   `expect.poll` for a background effect (event automation, #84 `2eeb47a`); wait for a dialog to close
   before checking the row (#89), for focus to return before the next control (#124), and for the
   feature switch before reading over it (#130).
2. **Measure at rest.** Run axe and visual checks after animations settle (#204).
3. **Navigation side effects.** Idle preloads started by the old document must finish or be released
   before asserting network or console state (#62).
4. **Slow runners.** Give a known slow boot its own timeout with the measured reason (#171), not a global
   increase.
5. **Network.** External tiles are blocked by host resolution in the config; never depend on them.
6. **Phones.** Layout widths belong to `sipges-phone-check`; CI fonts are wider than local ones.

## Reproduce a flake

```sh
pnpm --filter @sipges/e2e exec playwright test tests/<file> --repeat-each 20 --workers 2
pnpm --filter @sipges/e2e exec playwright test --shuffle   # Playwright 1.64+: exposes order dependence
```

Playwright 1.62–1.64 added `locator.waitForFunction()`, `locator.visible()`, test `lock` (tests that
share a resource never run together) and `retryStrategy: 'isolated'` (release notes, read 2026-11-03);
prefer them over ad hoc waits once the pinned version has them. A held version (see `.github/dependabot.yml`)
limits which APIs exist: check `apps/e2e/package.json` first.

## Checks

The fixed test passes 20 repeats locally, on every project it runs in. Synthetic data only. Commit as
`test(e2e): …` (or `fix(e2e): …` for harness code) with the cause in the body.

Reference: [Codex skills](https://developers.openai.com/codex/skills/),
[Playwright release notes](https://playwright.dev/docs/release-notes).
