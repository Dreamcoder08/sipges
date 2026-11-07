---
name: sipges-task-pr
description: "Use when verified SIPGES changes need to be pushed, a stacked draft PR opened, an existing task PR resumed, or an owner-authorized PR landed on main. Does not authorize merging, deployment, or messages to reviewers by itself."
---

# Entregar un PR apilado

Consulta la rama, `git status`, la base ODD y los PR existentes antes de escribir. Conserva cambios ajenos. La base es la rama de la tarea previa; herramientas/skills van en su propio PR y no se mezclan con T14.

1. Aplica `sipges-verify` a los cambios. Registra comandos/resultados y límites.
2. Busca un PR de la rama con `gh pr list --head <rama> --state open --json number,url,baseRefName`. Si existe, continúa ese PR. Si no existe, prepara un borrador con base explícita.
3. Crea commits pertinentes usando la identidad Git configurada; no inventes autores, trailers ni firmas de otra herramienta. Sube exclusivamente la rama trabajada con `git push -u origin <rama>`.
4. Redacta el cuerpo en español con problema/comportamiento resultante, motivo, validación y pendientes. La plantilla está en `assets/pr-body.md`.
5. Para crear: `gh pr create --draft --base <base> --head <rama> --title <título> --body-file <archivo>`. Para actualizar un PR existente, usa un argumento estructurado o `--body-file`. Si la versión de `gh pr edit` falla por Projects Classic, usa PATCH del PR vía `gh api --input <JSON>`.
6. Comprueba head/base, borrador, URL y CI del commit publicado. Ante CI roja, lee el primer fallo y corrige su causa antes de repetir.

Si se fusionó la base, inspecciona la nueva relación antes de retarget/integración. Evalúa divisiones por unidades independientes revisables; un número de líneas por sí solo no exige duplicar PR.

## Aterrizar (land), solo con merge autorizado

`scripts/agents/land-pr.sh <n> --merge` hace los pasos 1, 3 y 4 e imprime `CONFLICT`, `NOT_OPEN`, `BLOCKED`, `CHECKS_FAILED`, `MERGED` (solo con el head ya ancestro de `origin/main`), `DEPLOYED`, `DEPLOY_SUPERSEDED` (main ya avanzó; decide el despliegue posterior), `DEPLOY_FAILED` o `NO_DEPLOY` (un merge solo de docs no lanza despliegue). La salida 7 (`UNKNOWN_STATE`, `CHECKS_PENDING`, `HEAD_CHANGED`, `MERGE_UNCONFIRMED`, `DEPLOY_UNKNOWN`) significa que no se sabe, no que falló: lee el error de `gh` en stderr antes de repetir; repetir sobre un PR ya fusionado retoma sin fusionar dos veces. Sin `--merge` solo espera los checks e informa `READY`; `--no-deploy-wait` se detiene en `MERGED` para varios merges seguidos.

1. Espera los checks: `gh pr checks <n> --watch`. Ante uno rojo aplica `sipges-ci-triage`.
2. Si `gh pr view <n> --json mergeable,mergeStateStatus` dice `CONFLICTING`/`DIRTY`: `git fetch origin && git merge origin/main` en el worktree (nunca rebase ni force-push). El driver `union` de `.gitattributes` (T2 de `odd/tasks/conflict-free-delivery.md`) resuelve los logs de solo-agregado; lo que quede, con `sipges-sync-main`. Verifica, `git push` y vuelve al paso 1.
3. En verde y `MERGEABLE`: `gh pr ready <n>` si es borrador, luego `gh pr merge <n> --merge` (commit de merge, sin squash ni rebase). Un PR a la vez cuando hay varios en paralelo.
4. Confirma el despliegue: `Deploy Workers` arranca cuando termina la CI del push a main. `gh run list --branch main --workflow deploy-workers.yml --limit 1` y `gh run watch <id>` hasta que termine; informa su conclusión.

Merge, despliegue, asignaciones, suscripciones o mensajes a otras personas requieren autorización específica. Publicar un borrador ya autorizado no requiere reconfirmar. `sipges-odd-task` registra el cierre después de tener evidencia.

Entrega URL del PR reutilizado o creado, base, commit, estado de CI y pendientes.

Referencia: [skills oficiales de Codex](https://developers.openai.com/codex/skills/).
