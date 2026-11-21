# World-class local install (2026-11-21)

The backlog of the read-only expert audit of the owner's local install (8 dimensions plus a lead reviewer, verdict 62%).
Branch per task from `origin/main`; delivery `ask-on-risk`; runners: `deploy/local/test/unit.sh` (installer), `go test` (api-go), vitest (web), Playwright (e2e).

## Specs

- S1 — Owner (verbatim): «bien entonces el proyecto sipges ya funciona version local al 100% ?? o le faltan mas cosas ?? debe ser producto profesional con calidad cuestiona como los mejores del mundo , con informacion actualizada de la web y mas , llama mas expertos usa agentes + sub agentes , sub agentes dentro de sub agentes y mas y el consumo de memoria ram»
- S2 — Owner (verbatim): «perfect autorizo todo , confirmo y avanza has lo que sea necesario + buenas practicas de ingeneria de softwart y mas filosofia de gentleman y mas»

## Tasks

- T1 [ ] — S1, S2: bound PostgreSQL, Caddy and backup memory, tune PostgreSQL from the host size, enlarge /dev/shm, and divide the API budget by the replica count (audit B10). Route: inline. Commit: pending.
- T2 [ ] — S1, S2: calendar retention (14 daily, 8 weekly, 12 monthly, pre-update backups apart), a catch-up backup at start when the newest is older than 24 h, and `status` warning past 26 h (audit B4). Route: inline. Commit: pending.
- T3 [ ] — S1, S2: `status` warns on every run until a backup copy folder is set; optional off-site push of the sealed folders (audit B2). Route: inline; the destination is the owner's. Commit: pending.
- T4 [ ] — S1, S2: `./sipges recovery-kit`, a printable sheet with the confirmation of the passphrase's last 4 characters, and a `status` warning until done (audit B5). Route: inline. Commit: pending.
- T5 [ ] — S1, S2: harden the Claude bridge container (read-only root, no capabilities, memory limit, log rotation, API-only network) and document that real data needs a Console API key (audit B3). Route: inline; the provider choice is the owner's. Commit: pending.
- T6 [ ] — S1, S2: small operations fixes: build version in /health, no log line for 2xx health checks, `./sipges rollback` swapping images only, a free-disk guard, pnpm quarantine settings (audit B15). Route: inline. Commit: pending.
- T7 [ ] — S1, S2: honest empty states: IRSA «sin datos» on an empty project, a first-run checklist, first-use copy in Registros (audit B7). Route: inline. Commit: pending.
- T8 [ ] — S1, S2: password change and reset, a breached-password blocklist, one generic sign-in error and an idle timeout (audit B8). Risk: item 2 (identity). Route: inline plus independent verifier. Commit: pending.
- T9 [ ] — S1: Territorio freeze and the 3D loading state (audit B6). The lead reviewer marked the freeze unconfirmed; 2026-11-21 measurements without CDP network capture showed 0 blocking frames. Route: reproduce first, fix only what reproduces. Commit: pending.
- T10 [ ] — S1: analyst eval set, prompt caching, token accounting and a robust reply format (audit B13). Route: inline. Commit: pending.
- T11 [ ] — S1: retire the dual backend: one migration path, Go-only features, Go checks required in CI (audit B11). Route: after go-rust-stack T44 and T72. Commit: pending.
- T12 [ ] — S1: owner items: the USB for the Excel importer (audit B1, go-rust-stack T70), the off-site backup destination, the AI provider for real data, the Ley 29733 / DS 016-2024-JUS decisions with counsel (audit B9), the imagery licence for a commercial client (audit B12), phone access on the LAN, the production backend date, the laptop profile (closure-roadmap T27), the IRSA wording and the thesis text. Route: owner. Commit: n/a.

## Log

- L1 — Owner's request, verbatim: S1, then S2.
- L2 — 2026-11-21. Audit workflow wf_9834d280-144: 9 agents, read-only, current web sources. Scores: ux-product 52, security-privacy 72, reliability-ops 66, performance-ram 72, accessibility-mobile 76, data-domain 54, ai-analyst 62, engineering-quality 68; overall 62%. RAM at idle 160–250 MiB for the stack on a 7.2 GiB laptop: memory is not the problem. Server-side conversations (audit B14) stay out: the owner's delegated decision kept them in the browser (chat-first-ui T11). Next: T1.
