---
name: sipges-self-improve
description: "Use when asked to improve the agent setup, refresh skills, docs or workflows against current official sources, or on the periodic self-improvement review."
---

# Mejora continua del agente

Objetivo del usuario (2026-11-01): «que te mejores a ti mismo, de forma autónoma, siempre actualizado, siempre en la vanguardia, documentación también, flujos, estructuras y más». Toda mejora llega como PR con evidencia; nunca cambies reglas de seguridad, permisos ni el umbral de tres usos por tu cuenta.

1. **Fuentes frescas** (anota la fecha de consulta en `docs/agents/skills.md`):
   - [Novedades de Claude Code](https://code.claude.com/docs/en/changelog) y [skills de Claude Code](https://code.claude.com/docs/en/skills).
   - [Skills de Codex](https://developers.openai.com/codex/skills/).
   - `gh release list -R Gentleman-Programming/gentle-ai --limit 3` (las skills vendorizadas se actualizan reinstalándolas, nunca a mano: su hash está en `skills-lock.json`).
   - `~/.config/herdr-app/AGENTS.md` (Herdr lo reescribe en cada inicio) para los flujos en paralelo.
2. **Repetición**: revisa `git log origin/main --since=<última revisión>` y Engram (`mem_search` de bugfix, decision y discovery). Un flujo con ≥3 usos independientes y sin skill → créala con `skill-creator` y registra la evidencia. Una skill que falló o quedó desactualizada → corrígela con `skill-improver`. Una skill sin uso real → propón retirarla.
3. **Docs y estructura**: `AGENTS.md`, `docs/agents/`, el índice de ADRs y `odd/tasks/` deben coincidir con el código (rutas, comandos y scripts que existen). Corrige lo que mienta.
4. **Verifica cada afirmación** contra el repo antes de escribirla (por ejemplo, si una herramienta está activada). Si un dato no se puede comprobar, no lo escribas.
5. Cierre: `node --test scripts/tooling.test.mjs` y `sipges-verify`, un PR `chore(agents): …` con la tabla de cambios y sus fuentes, y `mem_save` de lo aprendido.

Cada skill nueva o cambiada de SIPGES vive en `.agents/skills/<nombre>/` y se enlaza desde `.claude/skills/<nombre>` (`ln -s ../../.agents/skills/<nombre>`).
