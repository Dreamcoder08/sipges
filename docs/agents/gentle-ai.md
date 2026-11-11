# Gentle AI y Engram en SIPGES

Fuente: [Gentleman-Programming/gentle-ai](https://github.com/Gentleman-Programming/gentle-ai) v4.2.0 y
[Engram](https://github.com/Gentleman-Programming/engram) v3.6.2 (actualizado el 2026-11-05 a pedido del dueño; v4.2.0 de Gentle AI revisado el 2026-10-19). Adoptado a petición
explícita del dueño del repositorio.

## Qué queda activo en el repositorio

| Pieza | Dónde | Efecto |
| --- | --- | --- |
| Memoria Engram (MCP) | `.mcp.json`, `.codex/config.toml` | Claude Code y Codex arrancan `node scripts/agents/engram.mjs mcp`: importa `.engram/` y sirve `engram mcp --tools=agent` con el proyecto fijo `sipges`. |
| Memoria compartida | `.engram/manifest.json`, `.engram/chunks/` | Fragmentos comprimidos que solo se añaden; viajan en git entre máquinas y sesiones en la nube. |
| Engram en la nube | `scripts/agents/engram.mjs` | Solo si `CLAUDE_CODE_REMOTE=true` descarga la versión fijada, comprueba su sha256 y la deja en `~/.local/bin`. En una máquina personal nunca instala nada: indica los pasos. |
| Guardarraíles de permisos | `.claude/settings.json` | Equivalente al componente `permissions` de Gentle AI: se niega leer `data/seed.json`, `data/*.db`, `.env*`, claves y `~/.ssh`. |
| Skills de Gentle AI | Instalación global | `chained-pr`, `work-unit-commits`, `cognitive-doc-design`, `judgment-day`, `skill-creator`, `skill-improver`, `typescript` y `zod-4` llegan con `gentle-ai install` o Gentle Shell. El repositorio no las copia (ver abajo). |
| ODD | `odd/tasks/`, skill `sipges-odd-task` | El ODD del repo ya sigue *Organic Driven Development*: trabajo pequeño en línea, trabajo grande con un documento recuperable. |

Comandos (`pnpm engram <comando>`, equivalente a `node scripts/agents/engram.mjs <comando>`):

| Comando | Uso |
| --- | --- |
| `mcp` | Lo usa el agente; no se ejecuta a mano. |
| `sync` | Exporta memorias nuevas a `.engram/chunks/`. Ejecutar antes del commit final y commitear `.engram/`. |
| `import` | Importa fragmentos de compañeros u otras sesiones (el servidor MCP ya lo hace al arrancar). |
| `status` | Compara fragmentos locales y del repositorio. |
| `install` | Muestra la ruta del binario (en la nube, lo instala). |

Reglas de memoria: guardar decisiones, correcciones, convenciones y hallazgos con el formato
**Qué / Por qué / Dónde / Aprendido**, en español y con `scope: project`. Nunca guardar datos reales,
datos personales, credenciales ni URLs privadas: los fragmentos se commitean.

## Una sola copia de cada skill genérica

Hasta noviembre de 2026 el repositorio copiaba las ocho skills genéricas de Gentle AI en `.agents/skills/`.
Con la instalación global y Gentle Shell cada agente veía dos o tres copias, y `.pi/settings.json` tenía
que desactivar las globales. Se quitaron las copias, sus entradas en `skills-lock.json` y ese parche.
`.claude/skills/` nunca las enlazó, así que Claude Code no cambia. Codex y Pi las toman de la instalación
global. En el repositorio quedan solo las skills `sipges-*` (flujos propios con tres usos o más) y las de
Neon, pedidas explícitamente.

## Qué no se adopta en el repositorio y por qué

| Pieza de Gentle AI | Motivo |
| --- | --- |
| Copias de las skills genéricas en `.agents/skills/` | Duplicaban la instalación global y obligaban a parchear Pi. |
| `.claude/CLAUDE.md` del orquestador (87 KB) | Se cargaría en cada sesión, duplica `AGENTS.md` y choca con el arnés de Claude Projects. Se resume en la sección *Gentle AI* de `AGENTS.md`. |
| Hooks RDD, telemetría y `skill-registry` | Ejecutan el binario `gentle-ai`, que no existe en las sesiones en la nube; fallarían en cada turno. |
| `react-19`, `playwright`, `go-testing`, `skill-registry` | `react-19` asume React Compiler (no activo aquí), `playwright` exige Page Objects que `apps/e2e` no usa, `go-testing` está orientada a Bubbletea y archivos golden (sigue disponible como skill global), y `skill-registry` depende del binario `gentle-ai`. |
| Context7 | Las sesiones en la nube ya tienen el conector; en local lo instala `gentle-ai`. |
| GGA (revisión con IA en pre-commit) | Requiere claves de proveedor en la máquina; opcional y local (`gga init && gga install`). |

## Pasos en tu máquina

macOS / Linux:

```bash
brew install gentleman-programming/tap/gentle-ai     # o el script curl del README de gentle-ai
gentle-ai install --agent claude-code,codex --preset ecosystem-only --persona neutral
gentle-ai doctor
engram setup claude-code                              # plugin con hooks de sesión y compactación
```

Windows (PowerShell, requiere Go 1.25.10+):

```powershell
go install github.com/gentleman-programming/gentle-ai/v4/cmd/gentle-ai@v4.2.0
go install github.com/Gentleman-Programming/engram/v3/cmd/engram@v3.6.2
gentle-ai install --agent claude-code,codex --preset ecosystem-only --persona neutral
```

Notas:

- La instalación global escribe en `~/.claude` y `~/.codex` (guía de orquestador, skills, hooks) y afecta a
  todos tus proyectos; hace copia de seguridad antes de cada escritura.
- Gentle AI envía telemetría anónima por defecto: `gentle-ai telemetry disable` la apaga.
- Si ya tienes un servidor `engram` de usuario, el de `.mcp.json` tiene prioridad en este repo y usa el mismo
  binario.
- Después de clonar o hacer pull, `pnpm engram import` trae las memorias del equipo.

### Project name in Engram

`.git/engram-project-identity.json` fixes the project for a clone and all its worktrees, whatever the remote says. It is local to each clone and must say `sipges`. `mascli` is the legacy name; it stays only as a key alias.
