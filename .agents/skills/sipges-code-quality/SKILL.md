---
name: sipges-code-quality
description: "Use when writing, refactoring or reviewing SIPGES code for quality, modularity, design patterns, scalability or performance, before a commit or PR."
---

# Calidad de código senior en SIPGES

Revisa solo las lentes que el cambio toca. Cada hallazgo lleva `archivo:línea`, severidad (bloqueante / aviso) y la regla o ADR que rompe. Arregla los bloqueantes antes del commit.

**Arquitectura** (ADR 0002, 0006; `.dependency-cruiser.cjs`): hexagonal por contexto. `domain` sin I/O; `application` con un caso de uso por comando/consulta y sus puertos; `infrastructure` y `http` dependen hacia adentro; DI manual en la raíz de composición. Los contextos se hablan solo por su API de aplicación exportada. En web, una feature no importa a otra: compón en `app/router.tsx` o `shared/api`. Nunca agregues excepciones a dependency-cruiser.

**Modularidad**: reutiliza el helper existente para estado compartido en vez de reimplementarlo con otra forma. Contratos Zod en `packages/contracts`, validados en el borde. Módulos chicos con un solo motivo de cambio.

**Patrones con propósito, no decorativos**: `Result` para fallos esperados y excepciones solo para bugs; Repository + Unit of Work con el contexto del tenant; Strategy para motores y clasificadores; Adapter para servicios externos; Policy para permisos y máquinas de estado.

**Seguridad y tenencia** (ADR 0003, 0009, 0030): toda consulta queda acotada por `projectId` bajo RLS; nada sale a IA externa sin pasar por el control de salida; nada de `dangerouslySetInnerHTML`; secretos solo en el entorno.

**Performance y escalabilidad**: sin N+1 (consultas por lote), índice para cada filtro nuevo, listas paginadas y nada cargado sin límite. En web: claves e invalidación de TanStack Query, sin store global, code splitting por ruta y `useMemo`/`memo` solo cuando una medición lo justifica (React Compiler no está activado). Presupuesto: p95 < 500 ms (`docs/benchmarks/README.md`). Respeta los límites de CPU y tiempo de Workers (ADR 0028).

**Frontend**: CSS Modules sobre tokens (ADR 0018), sin colores fijos, WCAG 2.2 AA, teléfono primero (`sipges-phone-check`).

**Tests**: comportamiento por la interfaz pública, un RED por regla, cada efecto observable afirmado, solo datos sintéticos.

**Legibilidad**: nombres del dominio; comentarios que explican el porqué; TypeScript estricto sin `any` ni `!`; artefactos en inglés.

Referencias: `docs/adr/`, [skills de Claude Code](https://code.claude.com/docs/en/skills), [skills de Codex](https://developers.openai.com/codex/skills/).
