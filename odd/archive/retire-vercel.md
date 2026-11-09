# Retire the Vercel host

Cloudflare Workers (Hyperdrive + Neon, R2) is the only SIPGES host. The Vercel demo held only
synthetic academic data; the Neon `neondb` database stays untouched as a backup.

## Specs

- S1 — «no entiendo porque sigues con vercel si ya estamos con claudflare»
- S2 — Chosen option: «Shut off Vercel without migrating»: «The Vercel demo data isn't needed: update the docs and delete the Vercel project. The neondb database stays in Neon untouched, as a backup.» Confirmed: «Yes, shut it off» — «Docs first, then delete the Vercel project, then a PR that removes apps/hosting.»
- S3 — Do not migrate the Vercel demo data (synthetic, in Neon `neondb`) into the Workers database, which holds the real AMSAC data.

## Tasks

- T1 — S1, S2: remove `apps/hosting` and `@vercel/*` dependencies, update living docs (overview, architecture, ADRs, deployment, integrations, diagram) and Vercel-specific comments/UI copy so Cloudflare Workers is the only host; history and closed ODD logs stay as written. Route: delegated worker (context backstop); parent synced `docs/diagrams/arquitectura.html` with the JSON by hand (pinned Archify tool not available locally). Done: lint, boundaries (796/2271), typecheck, web 326, API 766 + 14 skipped, hosting-cloudflare 14, tooling 9; independent verify mvxe2gp9-2-flpf PASS items 1–6, no severe finding. Commit: `chore(hosting): retire the Vercel host` (this PR).
- T2 — S2, S3: after T1 merges, delete the Vercel project `mascli-demo-academica` (and its GitHub check); leave Neon `neondb` untouched. Route: inline, owner's browser session. Done: `DELETE /api/v9/projects/prj_NspMzTB7H2Hp68XeqNtWBTZrn051` from the signed-in dashboard returned 204, then 404 on read; `mascli-demo-academica.vercel.app/health` 404. Storage list after: `neon-aero-brush` Available (no project connected), Blob `mascli-demo-synthetic-evidence` Available. Commit: n/a (external).
- T3 — S1: verify production `sipges.dreamcoder-dev08.workers.dev/health` 200 and that no Vercel check runs on new PRs. Route: inline. Done: `/health` 200 (`SIPGES V0.5.1`) after the project deletion; this evidence PR is the first one opened without a Vercel project. Commit: this PR.

## Log

- L1 — «no entiendo porque sigues con vercel si ya estamos con claudflare»; then «tu cual me recomindas ??»; recommendation accepted with «Yes, shut it off».
- L2 — Evidence: both hosts answered `/health` 200 on 2026-11-01. Vercel uses Neon `neondb` (synthetic demo); Workers uses its own database with the real AMSAC data (odd/archive/amsac-data-load.md). Vercel Hobby is non-commercial only (odd/archive/cloudflare-workers.md L2).
- L3 — T1 verify: S3 wording was ambiguous ("it" read as the Vercel demo); reworded so the real AMSAC data is clearly in the Workers database. Stale diagram `referenceCount` 44 → 41 fixed.
- L4 — T1 merged as PR #115 (`c1e6a5a`, CI 8/8). Finding before T2: the Neon project `neon-aero-brush`, which also holds the Workers database, is a Vercel Marketplace resource billed via Vercel, so only the Vercel project was deleted; the account and Neon integration stay (ADR 0029 consequences).
