# Skills locales de Codex

Fuente oficial consultada: [Build skills / Codex](https://developers.openai.com/codex/skills/) (redirige a [la guía vigente](https://learn.chatgpt.com/docs/build-skills)). Codex descubre skills del repositorio en `.agents/skills/`, con `name` y `description` en `SKILL.md`. Las instrucciones completas se cargan cuando la skill aplica. Los metadatos UI de `agents/openai.yaml` son opcionales; no se necesitan para estos flujos. Los campos de permisos de Claude no se representan como permisos de Codex.

El umbral de **más de dos usos** es una regla del usuario, no un requisito de OpenAI. Se cuentan tareas/entregas independientes, no iteraciones de una prueba, reintentos ni muestras internas de un benchmark.

El usuario solicitó explícitamente instalar `neon` y `neon-postgres` con `npx neon@latest skills -s neon -s neon-postgres -y`. Se importaron las skills oficiales de [neondatabase/agent-skills](https://github.com/neondatabase/agent-skills), usando Neon CLI 8.4.3 el 2026-10-13. `skills-lock.json` registra procedencia y hashes del instalador. Son instrucciones del proveedor solicitadas directamente, no nuevos flujos MASCLI creados por recurrencia. Instalar estas skills no autentica la CLI; la integración Neon/Vercel y la autenticación de CLI son conexiones distintas.

| Skill | Evidencia de al menos tres usos independientes |
| --- | --- |
| `mascli-verify` | Gates y CI de T11b (#18), T11c/d (#19), T12 (#20) y T13 (#21) |
| `mascli-odd-task` | Cierres ODD L58/T11, L59/T12 y L60/T13 |
| `mascli-task-pr` | Publicación de PR apilados #18, #19, #20 y #21 |
| `mascli-archify` | Commits de actualización `354b324`, `c6bb70b` y `2de7d97` |

Benchmarks conserva su [procedimiento](../benchmarks/README.md) y comparador existentes. Solo se archivan dos ejecuciones independientes (baseline/after); no se crea una skill de benchmark hasta demostrar una tercera necesidad independiente. Tampoco se crean skills específicas de migración o despliegue por una sola fase T13/T14.

Invocación explícita: `$mascli-verify`, `$mascli-odd-task`, `$mascli-task-pr` o `$mascli-archify`. La descripción determina cuándo aplica cada skill; `AGENTS.md` resume convenciones del repositorio sin cargar todas las instrucciones en cada tarea.

Las pruebas `node --test scripts/tooling.test.mjs` comprueban descubrimiento, metadatos y scripts. Las evaluaciones de agentes antes/después comprueban uso, selección, recuperación de PR existentes y respeto al umbral. Las comprobaciones no publican, despliegan ni usan datos reales por sí solas.
