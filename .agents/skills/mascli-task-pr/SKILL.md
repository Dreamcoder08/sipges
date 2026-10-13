---
name: mascli-task-pr
description: "Use when verified MASCLI changes need to be pushed, a stacked draft PR opened, or an existing task PR resumed. Does not authorize merging, deployment, or messages to reviewers."
---

# Entregar un PR apilado

Consulta la rama, `git status`, la base ODD y los PR existentes antes de escribir. Conserva cambios ajenos. La base es la rama de la tarea previa; herramientas/skills van en su propio PR y no se mezclan con T14.

1. Aplica `mascli-verify` a los cambios. Registra comandos/resultados y límites.
2. Busca un PR de la rama con `gh pr list --head <rama> --state open --json number,url,baseRefName`. Si existe, continúa ese PR. Si no existe, prepara un borrador con base explícita.
3. Crea commits pertinentes usando la identidad Git configurada; no inventes autores, trailers ni firmas de otra herramienta. Sube exclusivamente la rama trabajada con `git push -u origin <rama>`.
4. Redacta el cuerpo en español con problema/comportamiento resultante, motivo, validación y pendientes. La plantilla está en `assets/pr-body.md`.
5. Para crear: `gh pr create --draft --base <base> --head <rama> --title <título> --body-file <archivo>`. Para actualizar un PR existente, usa un argumento estructurado o `--body-file`. Si la versión de `gh pr edit` falla por Projects Classic, usa PATCH del PR vía `gh api --input <JSON>`.
6. Comprueba head/base, borrador, URL y CI del commit publicado. Ante CI roja, lee el primer fallo y corrige su causa antes de repetir.

Si se fusionó la base, inspecciona la nueva relación antes de retarget/integración. Evalúa divisiones por unidades independientes revisables; un número de líneas por sí solo no exige duplicar PR.

Merge, despliegue, asignaciones, suscripciones o mensajes a otras personas requieren autorización específica. Publicar un borrador ya autorizado no requiere reconfirmar. `mascli-odd-task` registra el cierre después de tener evidencia.

Entrega URL del PR reutilizado o creado, base, commit, estado de CI y pendientes.

Referencia: [skills oficiales de Codex](https://developers.openai.com/codex/skills/).
