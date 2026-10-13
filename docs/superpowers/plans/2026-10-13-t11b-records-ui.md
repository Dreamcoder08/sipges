# T11b territorial records and evidence implementation plan

> **For agentic workers:** Implement inline using superpowers:executing-plans and test-driven-development. Use one final independent review.

**Goal:** Replace T11b pending routes with usable TypeScript screens for events, actors, directory, demands/commitments, narratives and sources, including linked evidence.
**Architecture:** One isolated records feature owns typed API access, per-module form metadata, list/editor/detail UI and evidence handling. App routing supplies the authenticated scope and role. Existing HTTP/hexagonal services remain authoritative.
**Tech Stack:** React 19, TanStack Query/Router, Zod, CSS Modules, Vitest/Testing Library/MSW; existing Hono API.
**Spec:** docs/migration/web.md (T11b), docs/migration/records.md, docs/migration/evidence.md, odd/tasks/typescript-hexagonal-migration.md (S3, S7).

## Global constraints

- TypeScript only for new runtime code; retain Python as behavioral reference.
- No new dependencies; no imports of another feature's internals or API infrastructure.
- Preserve unknown payload fields and attachment links when PUT replaces a record.
- Only admin/analista may mutate these records; server authorization stays authoritative.
- Scope every query key and HTTP operation to company/project. Reset drafts on project change.
- Accessible labelled forms, escaped text, safe links, explicit deletion confirmation and server errors.
- Support upload retry without creating a duplicate source/event; do not claim an upload succeeded after failure.

## Review focus

1. Switching scope while a save/upload/download is in flight must not send old data to the new tenant.
2. Full replacement must retain unknown fields and evidence metadata.
3. Imported custom select values and directory aliases must remain visible/editable.
4. Failed uploads must leave the existing record available for a retry; 401 returns to login.
5. Untrusted narrative URLs and returned download URLs must not cause navigation to executable/external download URLs.

## Task 1: Operational records screens

Files: shared/api/client.ts; contracts/records.ts; features/records/{api,modules,model,RecordsPage,RecordEditor,RecordDetail,index}; app/{router,navigation}; test/records-api.ts; app/Records.test.tsx.
Interfaces: RecordsPage({module,scope,projectId,role}); scoped request({scope}); recordsQuery(module,scope,search); saveRecord(module,scope,payload,id?).
- [x] Write and run failing App tests for all screens, create/search/edit/delete, preserved fields, role restrictions, project switching and server errors.
- [x] Implement module-specific fields and a reusable responsive list/editor/detail, with full-replacement preservation.
- [x] Run focused records tests and typecheck; commit the working records feature.

## Task 2: Linked evidence

Files: contracts/evidence.ts; features/records/{evidence-api,EvidencePanel}; app/Evidence.test.tsx.
Interfaces: attachmentsQuery(module,id,scope); uploadAttachment(module,id,scope,file,metadata); downloadAttachment(id,scope).
- [x] Write and run failing tests for linked upload/list/download, retry after failed upload, role restrictions and expired sessions.
- [x] Implement evidence metadata and multipart upload on a saved record; authenticated fetch for downloads, followed by a local Blob URL.
- [x] Run focused evidence and records tests; commit linked evidence.

## Task 3: Verification and ODD delivery

Files: docs/migration/web.md; ODD task/log; README and architecture source/cards; plan checkboxes.
- [x] Run pnpm check and web build. Exercise CRUD, attachment upload/download and project isolation against a local API using synthetic data.
- [x] Review desktop/mobile screenshots and accessibility controls; update the architecture's source commit and T11b status only after verification.
- [ ] Obtain independent review; fix material findings with regressions. Commit and open a draft PR against docs/archify-architecture; no merge or deployment.

## Execution evidence

- Baseline web suite: 18 passed.
- Records first draft: 14 expected failures against pending screens, then 14 passed.
- Evidence first draft: 5 expected failures without the panel, then 5 passed. Node-compatible binary primitives in test setup fixed the jsdom/fetch multipart transport mismatch.
- Review fixes: three regressions failed before fixes, then passed; upload/edit overlap received an additional RED→GREEN regression. Final focused records/evidence run: 28 passed.
- Real browser: synthetic Hono/PGlite CRUD, upload/download bytes, evidence-preserving edit, deletion confirmation and tenant switching passed; 390px viewport contained the document.
- Independent review: three material findings fixed. Deferred parity notes: automatic event classification and fuzzy directory column lookup, documented in web.md; neither is claimed as parity-complete.

Final workspace: pnpm check exit 0, API 382 passed / 6 skipped, web 46 passed, kernel 3 passed; build exit 0. All material review findings fixed with regressions.
