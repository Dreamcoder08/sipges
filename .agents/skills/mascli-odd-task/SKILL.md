---
name: mascli-odd-task
description: "Use when an implemented MASCLI ODD task must be closed, its evidence recorded, or the next open task identified. A request to update the log alone does not prove task completion."
---

# Actualizar una tarea ODD

Lee `odd/tasks/typescript-hexagonal-migration.md` y los ADRs de la tarea. Preserva las especificaciones del usuario y los logs existentes. Comprueba que se completó lo pedido, que la verificación correspondiente pasó y que el PR existe; el script solo edita Markdown y no prueba esos requisitos.

Redacta evidencia breve en un archivo: cambio, comandos/resultados, revisión, límites y pendientes. No incluyas credenciales ni datos reales.

Desde la raíz:

```bash
corepack pnpm odd:close -- --task T14 --label "T14 E2E" --text @/tmp/evidence.txt --dry-run
```

Revisa que solo cambien la casilla de la tarea, `commit: see L<n>` y una entrada `L<max+1>`. Sustituye T14 por la tarea efectivamente completada. Ejecuta el mismo comando sin `--dry-run` y compromete el cambio con su verificación. Usa `--file` para otro ODD.

Una tarea ya cerrada no se vuelve a cerrar: el script rechaza la operación sin modificar el archivo. Añade correcciones de evidencia como cambios de documentación revisados, preservando el log original. Si falta una decisión necesaria para completar la tarea, registra el pendiente; no marques trabajo incompleto como terminado.

Entrega tarea, entrada de log, PR y pendientes. La publicación usa `mascli-task-pr`; la verificación usa `mascli-verify`.

Referencia: [skills oficiales de Codex](https://developers.openai.com/codex/skills/). Herramienta: `scripts/odd-close-task.mjs`.
