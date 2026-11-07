---
name: sipges-odd-task
description: "Use when an implemented SIPGES ODD task must be closed, its evidence recorded, or the next open task identified. A request to update the log alone does not prove task completion."
---

# Actualizar una tarea ODD

Ejecuta `pnpm odd:status` para ver qué ODD tiene tareas abiertas y lee solo ese documento y los ADRs de la tarea. Preserva las especificaciones del usuario y los logs existentes. Comprueba que se completó lo pedido, que la verificación correspondiente pasó y que el PR existe; el script solo edita Markdown y no prueba esos requisitos.

Redacta evidencia breve en un archivo: cambio, comandos/resultados, revisión, límites y pendientes. No incluyas credenciales ni datos reales.

Desde la raíz:

```bash
corepack pnpm odd:close -- --task T14 --label "T14 E2E" --text @evidencia.txt --file odd/tasks/<feature>.md --dry-run
```

Revisa que solo cambien la casilla de la tarea, `commit: see L<n>` y una entrada `L<max+1>`. Sustituye T14 por la tarea efectivamente completada. Ejecuta el mismo comando sin `--dry-run` y compromete el cambio con su verificación. `--file` es obligatorio. Para una entrada sin cierre de tarea, cambia `--task T14` por `--log-only`; acepta los formatos `- L<n> (`, `- L<n> — ` y `- L<n>:`.

Trabajo pequeño y entendido no necesita ODD (ver *Proportional work* en `AGENTS.md`); no crees un documento solo para registrarlo.

Una tarea ya cerrada no se vuelve a cerrar: el script rechaza la operación sin modificar el archivo. Añade correcciones de evidencia como cambios de documentación revisados, preservando el log original. Si falta una decisión necesaria para completar la tarea, registra el pendiente; no marques trabajo incompleto como terminado.

Entrega tarea, entrada de log, PR y pendientes. La publicación usa `sipges-task-pr`; la verificación usa `sipges-verify`.

Referencia: [skills oficiales de Codex](https://developers.openai.com/codex/skills/). Herramienta: `scripts/odd-close-task.mjs`.
