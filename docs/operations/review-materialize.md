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
| Representatividad y gobernanza | Actores (name «Por identificar», excerpt in «Rol o relación») |
| Demandas e intereses | Demandas |
| Compromisos y trazabilidad | Compromisos |
| Controversias y hechos compartidos | Hechos compartidos |
| Diálogo y construcción de consensos | Diálogos |
| Oportunidades de valor compartido | Valor compartido |
| Territorio y ambiente | Narrativas |
| Any other theme | Hechos compartidos |

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
