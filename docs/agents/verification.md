# Verificación de skills y scripts

2026-10-13. Skills adaptadas para descubrimiento nativo de Codex en `.agents/skills`; fuente oficial y evidencia de recurrencia en [skills.md](skills.md).

Baseline: un agente independiente no encontró ninguna skill en el directorio canónico, detectó instrucciones de publicación que no reutilizaban PR y comprobó que solo había dos benchmarks independientes. Tras adaptar cada skill, se repitieron escenarios de verificación, cierre ODD, continuación de PR y actualización Archify. Los cuatro escenarios pasaron; no se añadieron skills de benchmarking, migración o despliegue sin tres usos.

`node --test scripts/tooling.test.mjs`: cuatro pruebas aprobadas. Tres fallaron antes de corregir descubrimiento/scripts. Comprueban metadatos de Codex, ausencia de arranque automático de servicios/credenciales supuestas, propagación del estado de la verificación, dry-run sin cambios, número de log siguiente, rechazo de cierre repetido, evidencia vacía y etiquetas multilínea.

`corepack pnpm verify` aprobado: lint/formato, dependencias, tipos, API 418 aprobadas / 7 opcionales PostgreSQL omitidas, web 98, kernel 3 y cuatro pruebas tooling. Solo datos sintéticos; no se proporcionó conexión PostgreSQL local ni se arrancaron servicios.
