# Document lab and DOCX reports (T9)

Ports the document lab (`app.py:1700-1910`) and the four analysis Word reports
(`app.py:679, 906, 936, 955`). Document processing runs in memory behind ports: a
`DocumentReader` (pdf.js through `unpdf` for PDF, `fflate` plus a small WordprocessingML reader
for DOCX) and a `ReportRenderer` (the `docx` package). Report content is described with the
format-neutral `ReportDocument` outline in `@mascli/kernel`.

## Contract

| Route | Result | Errors |
| --- | --- | --- |
| `POST /system/document-lab/analyze` multipart `file`, optional `project_id` | findings JSON (`version: "2.1"`) | 400 empty, 403 other project, 413 too large or PDF over 100 pages, 415 type, 422 unreadable or no text |
| `POST /system/document-lab/report.docx` | `MASCLI_RC20_Lectura_Documental.docx` | as analyze |
| `POST /system/document-lab/compare` multipart `file_a`, `file_b` | up to 40 candidate pairs + total | 413 empty or too large, 415, 422 |
| `POST /system/document-lab/review/import` `{filename, sha256, items, project_id?}` | `{ok, new_items, message}` | 403 other project, 413 over 75 items, 422 bad SHA-256 or NUL |
| `GET /system/document-lab/review?status=` | `{items, total, limitations}`, newest first, at most 500 | |
| `PATCH /system/document-lab/review/{id}` `{status, reviewer?, note?}` | `{ok, id, status}` | 403 read-only role, 404, 422 status or missing corroboration note |
| `GET /system/situational-report.docx` | `MASCLI_Analisis_Situacional.docx` | |
| `GET /system/strategic-report.docx` | `MASCLI_Informe_Estrategico.docx` | |
| `GET /system/integrated-analysis.docx` | `MASCLI_RC19_Analisis_Integrado.docx` | |
| `GET /system/consensus-engine.docx` | `MASCLI_Motor_Valor_Consenso.docx` | |

Analyze, compare and the lab report are read-only POSTs open to every role (ADR 0008 #3).
Review import and decisions need a writing role. A decision writes an audit row
(`Laboratorio_Documental`, `REVIEW`, `<status> | <reviewer>`) in the same transaction.

## Parity

`test/documents/python-parity.fixture.json` is generated from `app.py` with synthetic text by
`scripts/python-parity/document-lab.py`. The tests check line splitting (`str.splitlines`, BOM),
findings, theme caps (12 per theme, 75 total), recommendation order, comparison candidates and
their order, and DOCX paragraph/table extraction of a python-docx file.

## Intentional differences

- **Project:** `project_id` defaults to the active scope; a different value in a form or body
  is refused (ADR 0008 #6). The review inbox lives in the tenant (`document_review`, forced RLS)
  and is part of the tenant JSON export.
- **Errors:** an unreadable document is a 422 with a generic message (app.py named the Python
  exception, and compare answered 500).
- **Limitations text:** app.py said the prototype had no authentication; that sentence now asks
  users to upload only documents authorized for the active project.
- **Author credits:** the consensus and strategic reports no longer print hard-coded personal
  names (ADR 0008 #13).
- **PDF text:** pdf.js and PyMuPDF can split lines differently inside a page, so PDF findings may
  differ in excerpt boundaries. TXT and DOCX keep parity.
- **Timestamps:** `generated_at` and review times are UTC with a `Z` suffix (ADR 0008 #14).

## Safety

Documents are never stored. Bodies above the upload limit plus 64 KiB of multipart overhead are
refused unread. PDFs over 100 pages are refused before any page is read. DOCX bodies are capped
at 32 MiB uncompressed.
