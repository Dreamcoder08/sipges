# Rename MASCLI to SIPGES

Replace every name and reference to MASCLI with the new product name, at once and without
backwards compatibility, as the owner chose.

## Specs

- S1 — «elimina todo el nombre o relacion con MASCLI este es su nuevo nombre , Sistema Inteligente de Predicción y GEStión Social-SIPGES»
- S2 — Chosen scope, verbatim: «Todo de una vez» — «Reemplazo total incluido datos y variables, sin compatibilidad. Requiere reconfigurar Worker y Vercel y cierra todas las sesiones.»

## Naming (applied everywhere)

| Before | After |
| --- | --- |
| MASCLI, MASCLI 4.0 (product) | SIPGES (Sistema Inteligente de Predicción y GEStión Social) |
| `@mascli/*` packages | `@sipges/*` |
| `MASCLI_*` environment variables | `SIPGES_*` |
| `X-MASCLI-Scope` and other `X-MASCLI-*` headers | `X-SIPGES-*` |
| cookie and storage keys containing `mascli` | same key with `sipges` |
| tenant company id `MASCLI` (scopes `MASCLI/<project>`) | `SIPGES` |
| stored values `MASCLI 4.0` (alert origin, audit module) | `SIPGES` |
| Worker `mascli`, R2 bucket `mascli-evidence`, Hyperdrive `mascli` | `sipges`, `sipges-evidence`, `sipges` |

## Exceptions (history, not product)

- `reference/python/**` (the legacy prototype that was named MASCLI; it is the behavioural reference).
- `odd/archive/**`, `odd/evidence/**`, `.engram/**`, already-closed ODD logs: they record what happened.
- Absolute local paths (`…/PROYECTOS/mascli/…`) and the GitHub repository URL until the repository itself is renamed.

## Tasks

- T1 [ ] S1,S2 — Code, packages, configuration, UI, docs, tests (one mechanical commit + reviewed fix-ups); route: worker after the in-flight PRs land; commit: own
- T2 [ ] S2 — Database migration: company id and stored `MASCLI 4.0` values, with RLS-safe rename and test; route: inline, test first; commit: own (risk item 1)
- T3 [ ] S2 — Workers deployment: new Worker `sipges`, secrets `SIPGES_*`, R2 bucket copy, Hyperdrive rename, Google OAuth redirect URI; route: inline; commit: config
- T4 [ ] S2 — Vercel: environment variables renamed (needs the owner's Vercel access); route: owner + inline
- T5 [ ] S1 — Repository rename on GitHub (redirects keep old links) and local remote update; route: owner word
- T6 [ ] S1,S2 — Independent verification (tenant isolation after the data migration, sessions, sign-in); route: gentle-ai-verify

## Risk

Items 1 (stored data rewritten), 2 (cookies, MFA and Google sign-in config), 3 (env and header contracts), 5 (deployment).

## Log

- L1 — «elimina todo el nombre o relacion con MASCLI este es su nuevo nombre , Sistema Inteligente de Predicción y GEStión Social-SIPGES»; scope question answered «Todo de una vez».
- L2 — Size on origin/main: 576 files, 3,309 occurrences; most frequent: `@mascli/contracts`, `MASCLI_COOKIE_SECURE`, `X-MASCLI-Scope`, `MASCLI/PRJ-SECHURA`, `MASCLI_TENANT`, `MASCLI_DATA_KEY`. Open PRs touching the same files (docs cleanup, human-validation wording) land first to avoid a 576-file conflict.
