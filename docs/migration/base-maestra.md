# Base Maestra (seed.json) → PostgreSQL

El prototipo Python cargaba `data/seed.json` («Base Maestra octubre 2026») en una base vacía
(`reference/python/app.py:125-134`). La versión TypeScript no lo hacía: el directorio, eventos,
actores, demandas y fuentes de esa matriz no estaban en PostgreSQL (auditoría funcional,
`odd/tasks/functional-audit-correction.md`, D2). Esta herramienta hace esa carga de forma
explícita y reversible.

- Solo inserta: un registro cuyo código ya existe no se modifica (las ediciones se conservan).
- Conserva cada fila tal cual; no añade marcas ni rellena campos.
- Códigos: el campo de identificación del módulo (`ID_Evento`, `ID_Demanda`, …) cuando existe;
  si no, `<prefijo>-<8 hex>` derivado del contenido, de modo que repetir la carga no duplica.
- `Usuarios`, `Roles` y `Proyectos` no se importan (se administran en la aplicación).
- Una entrada `IMPORT` de auditoría por módulo («Base Maestra: N registros nuevos desde …»).
- La salida contiene módulos, conteos y posiciones; nunca valores de registros.
- Una fila cuyo `Proyecto_ID` no esté vacío y sea distinto del proyecto de `--scope` es un problema:
  se informa por posición, sin el valor, también en la simulación. Se compara el valor exacto, de
  modo que `0`, `false` o un texto con otras mayúsculas o espacios tampoco coinciden. Las filas sin
  `Proyecto_ID` (ausente, `null` o `""`) se guardan como están, sin rellenar el campo.
- Cualquier problema del archivo bloquea toda la escritura, y la herramienta termina con código 1.

Si la instalación legacy aún tiene `data/sipges.db` y `data/uploads`, use primero
`migrate:legacy` (docs/migration/data-migration.md): trae los registros ya editados y los
informes adjuntos. Esta herramienta es para cuando solo se conserva la matriz `seed.json`.

## Uso

Requiere la autorización del propietario de los datos. Hacer copia de seguridad de la base.
El proyecto destino debe existir (se crea al iniciar la API o desde Administración).

```bash
# Simulación: informa qué se crearía; no escribe nada.
SIPGES_DATABASE_URL=… pnpm --filter @sipges/api import:base-maestra -- --seed data/seed.json

# Importación (por defecto en SIPGES/PRJ-SECHURA; otro: --scope EMPRESA/PROYECTO)
SIPGES_DATABASE_URL=… pnpm --filter @sipges/api import:base-maestra -- --seed data/seed.json --apply
```

Para revertir: los registros importados se identifican por la entrada de auditoría y sus
códigos; se eliminan desde la aplicación (cada borrado queda auditado y en el historial).
