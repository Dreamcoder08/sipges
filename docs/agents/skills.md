# Skills locales de Codex

Fuente oficial consultada: [Build skills / Codex](https://developers.openai.com/codex/skills/) (redirige a [la guía vigente](https://learn.chatgpt.com/docs/build-skills)). Codex descubre skills del repositorio en `.agents/skills/`, con `name` y `description` en `SKILL.md`. Las instrucciones completas se cargan cuando la skill aplica. Los metadatos UI de `agents/openai.yaml` son opcionales; no se necesitan para estos flujos. Los campos de permisos de Claude no se representan como permisos de Codex.

El umbral de **más de dos usos** es una regla del usuario, no un requisito de OpenAI. Se cuentan tareas/entregas independientes, no iteraciones de una prueba, reintentos ni muestras internas de un benchmark.

El usuario solicitó explícitamente instalar `neon` y `neon-postgres` con `npx neon@latest skills -s neon -s neon-postgres -y`. Se importaron las skills oficiales de [neondatabase/agent-skills](https://github.com/neondatabase/agent-skills), usando Neon CLI 8.4.3 el 2026-10-13. `skills-lock.json` registra procedencia y hashes del instalador. Son instrucciones del proveedor solicitadas directamente, no nuevos flujos SIPGES creados por recurrencia. Instalar estas skills no autentica la CLI; la integración de Neon con el host y la autenticación de CLI son conexiones distintas.

| Skill | Evidencia de al menos tres usos independientes |
| --- | --- |
| `sipges-verify` | Gates y CI de T11b (#18), T11c/d (#19), T12 (#20) y T13 (#21) |
| `sipges-odd-task` | Cierres ODD L58/T11, L59/T12 y L60/T13 |
| `sipges-task-pr` | Publicación de PR apilados #18, #19, #20 y #21; paso de aterrizaje (esperar checks, integrar main, merge commit, confirmar despliegue) repetido en #217, #219, #222, #223 y #224 |
| `sipges-archify` | Commits de actualización `354b324`, `c6bb70b` y `2de7d97` |
| `sipges-sync-main` | Integraciones de `main` en ramas de feature: `d582bee`, `c929201`, `1bb3233`, `264596a` y `9889bc3` (2026-10/11) |
| `sipges-ci-triage` | CI rota en #128 (e2e parity), #132 (360 px y puerto 55432 ocupado en el runner) y `71ef5f0` (carrera en e2e) |
| `sipges-phone-check` | Arreglos de ancho de teléfono `11a1b96`, `44ac859`, `bec39b3`, `3bd65d5` y `ab92898` |
| `sipges-self-improve` | Pedido explícito del usuario (2026-11-01): mejora continua de skills, docs y flujos con fuentes oficiales; fuentes consultadas el 2026-11-01 (Claude Code 2.1.316) |
| `sipges-code-quality` | Pedido explícito del usuario (2026-11-01); aplicada en las revisiones de #128, #131, #132 y el verificador de #130 |
| `sipges-go-port` | Puertos a Go de contextos de lectura con casos de paridad: reference (#217), audit (#219), management (#220), geography (#221), prevention (#222), situations (#223) e indicators (#225) |
| `sipges-rust-engine` | Motores TypeScript portados a Rust/WebAssembly/Go: indicators e IRSA (#206), los cinco de analytics (#214) y conflict-risk/text-analysis (rama `feat/rust-risk-text-engines`, con tablas generadas en commits propios) |
| `sipges-parallel-agents` | Pestañas paralelas de Herdr de la sesión del 2026-11-03 (una por unidad, worktree propio) que entregaron #203 a #225; el vigilante `scripts/agents/watch-tabs.sh` automatiza el seguimiento manual de `hc ls`/`hc read` |

El usuario pidió también adoptar Gentle AI (2026-10-19). Las skills `chained-pr`, `work-unit-commits`, `cognitive-doc-design`, `judgment-day`, `skill-creator`, `skill-improver`, `typescript` y `zod-4` son instrucciones de proveedor de [gentle-ai](https://github.com/Gentleman-Programming/gentle-ai) v4.2.0 y [Gentleman-Skills](https://github.com/Gentleman-Programming/Gentleman-Skills), sin modificar; `computedHash` es el sha256 de su `SKILL.md`. Ver [gentle-ai.md](gentle-ai.md).

Benchmarks conserva su [procedimiento](../benchmarks/README.md) y comparador existentes. Solo se archivan dos ejecuciones independientes (baseline/after); no se crea una skill de benchmark hasta demostrar una tercera necesidad independiente. Tampoco se crean skills específicas de migración o despliegue por una sola fase T13/T14.

Invocación explícita en Codex: `$sipges-verify`, `$sipges-odd-task`, `$sipges-task-pr`, `$sipges-archify`, `$sipges-sync-main`, `$sipges-ci-triage`, `$sipges-phone-check`, `$sipges-code-quality`, `$sipges-go-port`, `$sipges-rust-engine` o `$sipges-parallel-agents`.

Claude Code no lee `.agents/skills/`: descubre las skills de proyecto en `.claude/skills/` ([documentación oficial](https://code.claude.com/docs/en/skills), consultada el 2026-11-01). Cada skill SIPGES y Neon tiene allí un enlace simbólico a su carpeta en `.agents/skills/`, de modo que ambas herramientas leen la misma fuente; en Claude Code se invocan con `/sipges-verify`, etc. Las skills de Gentle AI no se enlazan porque Claude Code ya las recibe del instalador global de Gentle AI. La descripción determina cuándo aplica cada skill; `AGENTS.md` resume convenciones del repositorio sin cargar todas las instrucciones en cada tarea.

Las pruebas `node --test scripts/tooling.test.mjs` comprueban descubrimiento, metadatos y scripts. Las evaluaciones de agentes antes/después comprueban uso, selección, recuperación de PR existentes y respeto al umbral. Las comprobaciones no publican, despliegan ni usan datos reales por sí solas.
