---
name: sipges-sync-main
description: "Use when a SIPGES feature branch or worktree is behind main, its PR shows conflicts (DIRTY), or a sibling PR touching the same files just merged."
---

# Integrar main en una rama de feature

La rama ya está publicada y su PR abierto: **merge, nunca rebase ni force-push**.

1. En el worktree de la rama: `git fetch origin && git merge origin/main`.
2. Conflictos en documentos de solo-agregado (`CHANGELOG.md`, `## Log` de `odd/tasks/*.md`): desde la raíz, `python3 .agents/skills/sipges-sync-main/scripts/resolve-doc-conflicts.py <rutas relativas>`. Conserva primero lo de main, agrega lo de la rama y renumera su `L<n>`.
3. Conflictos de código: resuelve a mano conservando ambos comportamientos. Puntos calientes conocidos: `apps/web/src/app/router.tsx`, `navigation.ts` y su test (cantidad de `SCREENS`), `layout/AppShell.test.tsx`, `Hubs.test.tsx`. Recalcula conteos desde el código, no los adivines.
4. Sin marcadores: `git diff --check` y `git grep -nE '^(<<<<<<<|>>>>>>>)'` deben salir vacíos.
5. Aplica `sipges-verify` leyendo el código de salida directamente (`pnpm verify; echo $?`), nunca a través de `| tail`.
6. `git add -A && git commit --no-edit && git push`. El PR conserva su auto-merge.

Si dos ramas chocan en los mismos archivos, intégralas en serie: la segunda vuelve a integrar main cuando entra la primera.

Referencias: [skills de Claude Code](https://code.claude.com/docs/en/skills), [skills de Codex](https://developers.openai.com/codex/skills/).
