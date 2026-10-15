# Real Data Only

Leave every module with the project's own information only, chart narratives over time and make
the territorial directory table readable. Branch `claude/project-thread-xn1t1j` from `main`
1b99d3d (PR #48 merged).

## Specs
- S1: "he visto que aún hay información ejemplo… esto se puede quitar para que quede solo lo que sí es del proyecto… los ejemplos demostrativos eso ya sácalos" (owner, 2026-10-15, screenshot of the directory with «12 de demostración (ocultos)» and the «Origen» filter).
- S2: "en las tendencias narrativas podría salir un gráfico como el de la imagen" (owner, 2026-10-15): one line per day and category (Medio ambiente, Gobernanza, Demandas y compromisos, Actores e influencia, Narrativas y señales digitales), from real data.
- S3: "corrige el diseño en la segunda imagen, ingresé algunos números y se ven así" (owner, 2026-10-15): directory phones split over two lines and a cramped «Prioridad» column.
- S4: Default chosen by the coordinator: delete the demo data (database and code), not just hide it; merge to `main` once CI is green so the public site shows it (owner asked before to see changes on the public site).
- S5: Keep the existing guarantees: hexagonal boundaries, tenant isolation, CSP, WCAG 2.1 AA, every existing test green.

## Findings
- F1: The synthetic academic case (`demo:seed`, dataset mascli-academic-v1, scope MASCLI/PRJ-SECHURA) is stored in the production database next to the real records: records marked `Dato_Sintetico`/`Demo_Dataset`, ten evidence files and an IRSA snapshot noted «DEMO mascli-academic-v1». The app only hid them (PR #46: «Origen» filter, «Demostración» badge, `demostracion` counters, `DemoDataNotice`).
- F2: Narratives have no category field; the image's categories are the MASCLI dimensions E, G, D, A and N.
- F3: Table cells use `overflow-wrap: anywhere`, so the narrowest column shrinks below a phone number's width.

## Tasks
- T1 [ ] S1,S4 — Migration 0019 deletes the demo records (evidence, links and embeddings cascade) and the demo IRSA snapshot in every tenant through forced RLS; remove the demo tool, the origin filter and badge, the demo counters and notices, and their tests and docs; route: inline; commit:
- T2 [ ] S2 — «Tendencia temporal de narrativas» on the Narrativas screen: narratives per day and category (optional «Categoría» field, else inferred from topic and description, N by default), 30/90 days or all; route: inline; commit:
- T3 [ ] S3 — Phones, dates, numbers and short choices stay on one line in record tables; route: inline; commit:
- T4 [ ] S5 — `pnpm verify` with PostgreSQL, merge and public deploy check; route: verify; commit:

## Log
- L1 (plan, 2026-10-15): Read the two screenshots, the demo tool, PR #46 provenance code and the record tables; findings F1-F3 above.
