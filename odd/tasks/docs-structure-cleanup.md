# Documentation quality, structure and redundancy cleanup

Make the repository's documentation quick to navigate and free of redundancy, following the
Gentleman/gentle-shell conventions: a short README as the entry point, one page per topic under
`docs/`, history in one place, and nothing obsolete at the repository root.

## Specs

- S1 — «algo que tambien quiero que hagas es mejorar la calidad , estructura de la documentacion eliminar redundancia»
- S2 — «siguiendo las buenas practicas de gentleman , https://github.com/Gentleman-Programming/gentle-shell»

## Reference conventions (gentle-shell, observed 2026-10-31)

- Root keeps only entry files (README, license, contributor/agent guides); history lives in releases or one changelog.
- README: tagline, quickstart, short "how it works" sections, each ending with a `Docs →` link.
- `docs/`: flat topic pages plus `docs/assets/` for images and diagrams.

## Tasks

- T1 [x] S1 — Read-only audit: inventory of every documentation file (root, docs/, odd/), what each covers, duplicates and contradictions, broken links, obsolete material; route: gentle-ai-explore; commit: none
- T2 [x] S1,S2 — Target structure and move/merge/delete map; route: inline; commit: this document
- T3 [ ] S1,S2 — Root cleanup: legacy release notes and test results consolidated into history, legacy launchers moved under reference/python; route: worker; commit: own
- T4 [ ] S1,S2 — README rewrite and docs/ index; merge duplicate pages; fix links; route: worker; commit: own
- T5 [ ] S1 — Verification: link check, nothing referenced is lost, lint/format; route: inline; commit: final

## Target map (T2)

Root keeps README.md, CHANGELOG.md, CONTRIBUTING.md, AGENTS.md, CLAUDE.md and tooling config only.

| From | To | Why |
| --- | --- | --- |
| NOVEDADES_RC_*.md, RELEASE_NOTES_*.txt, RESULTADO_PRUEBA_*.txt, PRUEBAS_RC_2_7.txt, PILOTO_RETEST_V0_5_1.json | reference/python/history/ (git mv) + one summary page docs/history/python-prototype.md | History of the Python prototype, not of the TypeScript app |
| start_mascli.*, INICIAR_MASCLI_FINAL.bat, iniciar_mascli_final.sh | reference/python/ | They start `app:app`, which only resolves there |
| IRSA_ESPECIFICACION_TECNICA.txt, NUEVO_MODULO_ANALISIS_SITUACIONAL.txt | reference/python/docs/ | Prototype specs; the executable IRSA reference is docs/escenarios/irsa.md |
| docs/export-isolation.md, storage-backend.md, mfa-enrollment.md | reference/python/docs/ | Prototype fixes, superseded by ADRs |
| docs/VERIFICACION.md, agents/verification.md, migration/t11*/t14-verification/main-consolidation/merged-branches.json, qa/*, deployment/public-demo-verification.md | docs/history/ | Evidence logs, not guides |
| docs/testing/verification.md + docs/agents/testing.md | docs/testing.md | One testing guide |
| docs/superpowers/ | deleted | Another tool's plans, no referrers |
| — | docs/README.md | Index: one line per topic page |
| README.md | rewritten short: tagline, quickstart, sections ending in `Docs →` | gentle-shell convention |
| CHANGELOG.md | add «Pre-1.0 — Python prototype» entry linking docs/history/python-prototype.md | Closes the dangling «see history» |

Kept in place on purpose: docs/ARQUITECTURA.md and docs/diagrams (Archify skill paths), docs/escenarios (read by apps/api/test/scenarios.test.ts), docs/adr numbering.

## Log

- L1 — «algo que tambien quiero que hagas es mejorar la calidad , estructura de la documentacion eliminar redundancia , [eza listing of the repository root] siguiendo las buenas practicas de gentleman , https://github.com/Gentleman-Programming/gentle-shell»
- L2 — The listing came from the main checkout (`feature/mascli-clean-rebuild`); the same legacy files are tracked on `main`: 14 NOVEDADES_RC_*.md, 2 RELEASE_NOTES_*, 4 RESULTADO_PRUEBA_*, PRUEBAS_RC_2_7, PILOTO_RETEST_V0_5_1.json, IRSA_ESPECIFICACION_TECNICA.txt, NUEVO_MODULO_ANALISIS_SITUACIONAL.txt, 4 launchers; docs/ holds 102 files. Work happens on branch `docs/structure-cleanup` from `origin/main`.

- L3 — Audit (explorer mvx0dw43-4-repg): the four launchers run `uvicorn app:app` from the root and are broken since app.py moved to reference/python; docs/secure-cookies.md:18 still describes them; CHANGELOG has nothing before 1.0 though README points to it; three or four overlapping verification pages; docs/superpowers has no referrers; migration/web.md:108 stale status. No broken links found by search (real link check pending in T5).
