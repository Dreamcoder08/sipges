# Review approvals into records

Approving a document lab finding creates its record in the project's module. Items approved
before that existed have no record; `review:materialize` creates them. Task: functional-closure
T23 (S13).

> **Production needs the owner's word.** This writes records into a real project. Run the dry
> run first, show the owner its counts, and run `--apply` only after they say so.

## What approving does

The two approving decisions are «Aceptado para revisión» and «Corroborado documentalmente».
«Pendiente» and «Descartado» never create a record, and discarding later does not delete one.

| Finding theme | Module |
| --- | --- |
| Actor (extracción automática) | Actores (unidentified name; original excerpt in «Rol o relación») |
| Representatividad y gobernanza | Actores (name «Por identificar», excerpt in «Rol o relación») |
| Demandas e intereses | Demandas |
| Compromisos y trazabilidad | Compromisos |
| Controversias y hechos compartidos | Hechos compartidos |
| Diálogo y construcción de consensos | Diálogos |
| Oportunidades de valor compartido | Valor compartido |
| Territorio y ambiente | Narrativas |
| Any other theme | Hechos compartidos |

An automatic actor finding is still an unverified extraction: acceptance routes it to Actores,
but does not identify the person or organization or certify the excerpt. Review the original
source before replacing the unidentified name; approval never infers identity or territory.

Every record carries:

- `Proyecto_ID`: the active project.
- `Fuente_ID`: source file and location.
- `Revision_Documental_ID`: the review item it came from.
- `Observaciones`: decision, reviewer, theme, suggested action, review note and the document's
  SHA-256 — every value without a field of its own.

The record id is `REV-<review item id>`. Approving twice, or approving and then running the
backfill, finds the same id and creates nothing. Existing records are never overwritten, so
edits made in Registros survive.

The inbox says «Al aprobar, se crea el registro en <Módulo>» and links the record once it exists.

## Bulk approval

`POST /system/document-lab/review/bulk` decides many pending items of the active project at
once (functional-closure T26). It takes the single decision's path for each item: the same
audit row (`REVIEW`, «<decision> | <acting user>») and the same `REV-<id>` record.

| Field | Meaning |
| --- | --- |
| `ids` | Explicit items, up to 1,000. |
| `theme`, `source_sha256` | Or a filter: pending items of a theme and/or a source document. |
| `status` | `aceptado_para_revision`, `corroborado_documentalmente` (needs `note`) or `descartado`. |
| `note` | Optional review note, required to corroborate. |
| `dry_run` | `true` counts what would happen per module and writes nothing. |

- The reviewer is the signed-in user, never a body field. Admin and analista only, like the
  single decision; consulta and coordinador get 403.
- Only «Pendiente» items are touched. Ids already decided, missing or from another project
  count as `skipped`; running the request again decides and creates nothing new.
- Transactions of 200 items, at most 1,000 per request. A filter with more pending items
  reports the rest in `remaining`: send the same request again.
- Decisions commit before their records. If a records batch fails, `problems` says so and
  `review:materialize --apply` creates the missing records later under the same ids.

The response carries counts only:

```json
{
  "ok": true,
  "dry_run": false,
  "decided": 200,
  "records_created": 200,
  "skipped": 0,
  "remaining": 2415,
  "modules": [{ "module": "demandas", "label": "Demandas", "nuevos": 200, "ya_existentes": 0 }],
  "problems": []
}
```

In the inbox (Situación › Bandeja de revisión documental), admin and analista see:

- a checkbox on each pending item and «Seleccionar todos los visibles» (the current page);
- «Aprobar seleccionados (N)» and «Descartar seleccionados»;
- on each pending item, «Aprobar todos los pendientes de este tema» and «… de este documento».

Every action opens a confirmation that first runs the dry run and shows how many items it
decides and how many records it creates per module. A bulk approval is «Aceptado para
revisión»; corroborating still goes item by item, with its evidence note.

Discarding later is the single decision («Descartado»): the record stays, as with any approval.

## Run the backfill

The CLI targets the database of the API configuration: `SIPGES_DATABASE_URL`, or
`SIPGES_PGLITE_DIR` for a local PGlite. Never paste a connection string into a document,
commit or chat.

1. Dry run, every project (writes nothing):

   ```sh
   pnpm --filter @sipges/api review:materialize
   ```

2. Dry run, one project:

   ```sh
   pnpm --filter @sipges/api review:materialize -- --scope SIPGES/PRJ-SECHURA
   ```

3. With the owner's word, apply (same flags plus `--apply`):

   ```sh
   pnpm --filter @sipges/api review:materialize -- --scope SIPGES/PRJ-SECHURA --apply
   ```

The output is JSON with counts only, per project and module:

```json
{
  "applied": false,
  "tenants": [
    {
      "tenant": "SIPGES/PRJ-SECHURA",
      "approved": 3,
      "modules": [{ "module": "compromisos", "nuevos": 2, "ya_existentes": 1 }],
      "problems": []
    }
  ],
  "missing": []
}
```

- `nuevos`: records created (dry run: records it would create).
- `ya_existentes`: approved items whose record already exists.
- Exit code 1 when a project in `--scope` does not exist or a batch was refused (`problems`).

## Failures and resuming

Projects run one after another. Within a project, each module's batch of up to 500 items is
one records transaction with one «IMPORT» audit entry; a failure rolls back that batch only.
Run the same command again: records already created are counted as `ya_existentes` and the
rest are created. Nothing else needs cleaning up.

Pending items («Pendiente») are not touched: the AMSAC queue still needs human review (T25).

## Actor names and pending documentary mentions

The actor workspace opens the **Padrón con nombre** view. Records without a name or with the
`Por identificar (...)` placeholder remain accessible under **Menciones pendientes**, with
the original excerpt and record detail. They are excluded from the strategic actor map and
flagged in the data-quality queue. Switching views does not rewrite or delete records.

A supplied name does not imply corroborated identity. Workspace counts describe the current
search result; generic API, hub and dashboard totals still count stored records, including
pending mentions. Use the named register, not the raw stored-record total, when describing
identified actors. Complete names only from directly supporting source evidence; do not infer
identity, territory or responsible people from nearby document mentions.
