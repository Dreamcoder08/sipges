# Reporting MCP: aggregate counts over the read-only MCP

Objective: one read-only MCP tool that counts records of a module, optionally grouped by a closed-list field and
bounded by dates, so an agent can build reports without reading every record. Branch `docs/claude-desktop-mcp`
(closure-roadmap T37, first slice). Delivery: `ask-on-risk`. Runners: Vitest (`apps/api`), `go test` (`apps/api-go`),
`pnpm parity`.

## Specs

- S1 — Owner's vision (closure-roadmap S8): «un MCP de lectura para el sistema , así sacan todos los reportes que se
  les ocurran.»
- S2 — Owner's choice of slice: «te autorizo todo , has lo que haria gentleman + buenas practicas y avanza», answering
  the question whether to start with «el MCP de reportes (agregaciones de solo lectura, el de menor riesgo)».
- S3 — Tool `count_records`, arguments `module` (required), `group_by` (optional field), `from`/`to` (optional, AAAA,
  AAAA-MM or AAAA-MM-DD, on the module's date field). Answers the total and, when grouped, `{ value, count }` groups,
  largest first; empty values count under `value: null`. Exact contract (both APIs):
  - Input, zod in `apps/api/src/contexts/integration/http/mcp-tools.ts`, placed right after `get_timeline`:
    `z.object({ module: Module, group_by: z.string().max(80).default('').describe('Campo por el que agrupar: solo
    campos de lista cerrada, códigos, fechas o números; vacío = solo el total'), from: z.string().max(10).default('')
    .describe('AAAA, AAAA-MM o AAAA-MM-DD sobre el campo de fecha del tipo; vacío = sin límite'), to:
    z.string().max(10).default('') })`; title `Conteo de registros`; description `Cuenta los registros de un tipo de
    objeto, opcionalmente agrupados por un campo de lista cerrada y acotados por fechas. Úsalo para totales y
    reportes en lugar de leer registro por registro.`
  - Output: `{ module, group_by, from, to, total, truncated, groups }`; `group_by`, `from`, `to` are null when empty
    (`from`/`to` hold the expanded day bounds otherwise); `groups` is `[]` without `group_by`, else
    `[{ value, count }]` sorted by count descending, then value ascending as text, `null` last.
  - Without dates every record of the module counts; with either date only records whose date field has an ISO
    `yyyy-mm-dd` prefix inside the bounds count. At most 20000 records are read; `truncated` says more existed.
  - Errors (tool result `isError`): unknown module as the existing tools word it; invalid dates «Fechas no válidas:
    use AAAA, AAAA-MM o AAAA-MM-DD»; dates on a type without date field «El tipo de objeto <slug> no tiene campo de
    fecha»; a field that is not `clear` or not allowed «No se puede agrupar por «<field>»: solo campos de lista
    cerrada, códigos, fechas o números».
- S4 — Privacy (ADR 0030), assumption derived from the guard, not asked by the owner: the tool is refused while
  «Envío a IA externa» is off; `group_by` is accepted only for fields whose policy is `clear` (closed lists, codes,
  dates, numbers), so no name or free text becomes a key; restricted records are not counted, as every other tool
  hides them; every counted record passes through the guard's session and its access log.
- S5 — Same behaviour in the TypeScript API (used by the desktop install) and the Go API, proved by parity cases.

## Tasks

- T1 [x] — S3, S4: TypeScript `count_records` (store query, ontology service, MCP tool, tests). Route: delegated,
  Herdr tab `report-ts` (writer reason: parallel with T2, disjoint surface `apps/api/**`).
- T2 [x] — S3–S5: Go `count_records` (descriptors, analyst label, tests). Route: delegated, Herdr tab `report-go`
  (writer reason: parallel with T1, disjoint surface `apps/api-go/**`).
- T3 [x] — S5: parity cases (switch off, grouped, dates, refused field, restricted) and the seam check
  (`mcp.mjs --check` on the merged code). Route: inline, after T1 and T2.
- T4 [x] — S1: docs (MCP instructions text, desktop README tool list, CHANGELOG). Route: inline.
- T5 [x] — S4: independent verification. Risk item 2 (data leaving through the egress guard). Route: verifier.

## Log

- L1 — 2026-11-17 — Owner's request: «te autorizo todo , has lo que haria gentleman + buenas practicas y avanza»,
  after the vision «MCP para el setup. nadie quiere leer tu manual ni ver tu tutorial de cómo configurar tu producto,
  todo va a ser por chat. - UI para ver los números. dashboards claros, limpios, y custom, con las cifras grandes a la
  vista, y les puedes preguntar.» and «un MCP de lectura para el sistema , así sacan todos los reportes que se les
  ocurran.»
- L2 — 2026-11-17 — Map: no generic aggregation exists (dashboard counters are fixed; records summary is per module
  only). Reuse the ontology date bound (`dayBound`) and the guard session; a SQL GROUP BY would count restricted rows
  and could key on names, so values are counted after `egress.records`. Go descriptors are generated from the TS
  `MCP_TOOLS` by `apps/api-go/internal/integration/testdata/mcp.mjs`; `apps/api/test/privacy/structure.test.ts` pins
  the tool list.
- L3 — T1: T1 done in Herdr tab report-ts, PR #522 (2ae7d362): count_records in the TypeScript API; 10 RED tests then GREEN (11 in count-records.test.ts), API suite 1256 passed; one-line re-export of policyFor in privacy/application/index.ts accepted (boundary rule). verify:fast died of memory (7 GB machine), not of a test.
- L4 — T2: T2 done in Herdr tab report-go, PR #520: count_records in Go, RED then GREEN against a throwaway PostgreSQL, go vet and golangci-lint clean, progress label «Contando registros…». Seam: mcp.mjs --check on the merged branches found the MCP instructions text differed (TS named count_records); fixed in Go (2a7dc674).
- L5 — T3: T3 done on feat/report-mcp-go (0ccca35d, a77b0ca0): 26 count_records parity cases; pnpm parity 2637/2639 (the two misses are the known Node 26 multipart upload cases).
- L6 — T5: T5 independent verifier: S1, S2, S4 PASS (no leak: only clear fields group, values scrubbed, restricted never counted, RLS and tenant hold, one access-log row of ids and counts); S3/S5 FAIL on blank and one-sided arguments (Go did not trim, TS echoed open bounds). One correction batch a77b0ca0, RED then GREEN in both APIs, recheck by six parity probes: match. Advisories kept open: grouping by id or date fields can return up to 20000 groups; total is a lower bound when truncated.
- L7 — T4: T4 done: MCP instructions name count_records in both APIs (TS 2ae7d362, Go 2a7dc674); deploy/desktop/README*.md list seven read-only tools with count_records.
- L8 — landing: Landed with the owners word («Sí, mergeá y desplegá»): PR #520 merged as 31c737af (it carried #522, which GitHub marked merged). Deploy Workers run 44251963830 failed at «Apply database migrations» on the Neon quota («Your account or project has exceeded the quota»), the same outage as closure-roadmap T12; count_records is on main but not in production until the quota is resolved.
