# Carga de datos reales AMSAC: Sechura y El Algarrobo

Load the owner's AMSAC reports into the deployed Workers instance: Sechura already exists, El Algarrobo is
created. Reports become sources with their file in private R2, and the document lab queues extracted
items for human validation. Source drive: the owner's KINGSTON USB, folder `AMSAC` (read-only).

## Specs

- S1 — «ayudamne ahora con los datos e informacion , /run/media/dreamcoder08/KINGSTON/AMSAC , agrega el proyecto sechura + proyecto el alagarrobo»
- S2 — Chosen option, verbatim: «Fuentes + registros extraídos para validar»

## Constraints (from AGENTS.md and the chosen option, not new requirements)

- Real data never enters the repository, tests, fixtures, Engram or the transcript; only counts and
  categories are recorded here.
- Personal and administrative files are excluded: CVs, RNP certificates, sworn statements, due
  diligence forms, tax receipts and their XML, payment letters, quotations, professional
  certificates, personal finance sheets, third-party theses and unrelated academic work.
- Extracted items stay pending human validation; nothing is auto-approved.
- Target: the Workers deployment (`mascli.dreamcoder-dev08.workers.dev`) with its own database; the
  Vercel production database is not touched.

## Tasks

- T1 [x] S1 — Inventory and classification manifest (project, include/exclude, dedupe of versions) outside the repository; owner confirms ambiguous files; route: bounded explore; commit: none (data)
- T2 [x] S1 — Create project El Algarrobo and grant both administrators; route: inline; commit: log only
- T3 [x] S1,S2 — Upload confirmed reports as sources with evidence, per project; route: inline script; commit: log only
- T4 [x] S2 — Document lab analysis and review import, pending validation; route: inline script; commit: log only
- T5 [x] S1,S2 — Independent verification (tenant separation, exclusions, counts); route: gentle-ai-verify; commit: log only

## Risk

Item 1 (real data written to a public deployment) and tenant isolation between the two projects.

## Log

- L1 — «ayudamne ahora con los datos e informacion , /run/media/dreamcoder08/KINGSTON/AMSAC , agrega el proyecto sechura + proyecto el alagarrobo»; to the scope question chose «Fuentes + registros extraídos para validar».
- L2 — Inventory: 141 files, 224 MB (88 PDF, 41 DOCX, 5 XML, 3 PPTX, 2 XLSX, 1 JPG, 1 DOC). The document lab (`/system/document-lab/analyze`, `review/import`, `PATCH review/:id`) provides the validation queue; review import stores excerpts only.
- L3 — Owner excluded three unclassifiable files («Dejarlos afuera (recomendado)») and later dropped the corrupt JPG and two PPTX («no importa igual avanza»). Manifest: 39 documents (14 both, 18 Sechura, 7 El Algarrobo); 102 files excluded. Project `MASCLI/PRJ-ALGARROBO` created and granted to both administrators.
- L4 — 53 sources created (34 Sechura incl. 2 synthetic checks, 21 El Algarrobo), 50 with their file in R2. A loader bug read `_id` instead of `id`; ids were recovered from the log, no duplicates. Upload limit raised to 25 MB (`SIPGES_MAX_UPLOAD_BYTES`).
- L5 — Owner asked to question the approach with current information («cuestiona y consulta ... octubre 2026») and approved a Clairic pilot. Pilot on 3 reports: actors grounded 100% and dates reliable; demands, commitments and actions came back as 1–3 word fragments; conflict level inconsistent. Queue built from Clairic actors (deduplicated, ≥4 chars) plus the document lab's «Demandas e intereses» and «Compromisos y trazabilidad» passages; Clairic cost about USD 0.03.
- L6 — Cleanup (status only, reversible, with notes): off-theme lexical items and cross-document duplicate actors discarded. A dry run revealed that the Neon role bypasses RLS; scripts now `SET LOCAL ROLE mascli_tenant` like the app and filter tenant_id explicitly. Pending: Sechura 1,144 actors / 208 commitments / 126 demands; El Algarrobo 1,004 / 182 / 107. The review list was capped at 500 rows: PR #99 added pagination and a theme filter.
- L7 — T5 independent verification (mvx2tdaw-8-ssac): PASS on tenant separation, exclusions (0 of 102 excluded files' hashes stored), counts and exposure; the parent closed the exposure caveat with a read-only count across all tenants: manifest hashes appear only in the two AMSAC tenants (review 2,615 / 2,056; attachments 30 / 20). Two Sechura PDFs without extractable text have no review items (need OCR).

