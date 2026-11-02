---
name: sipges-verify
description: "Use when SIPGES code, scripts or configuration must be verified before a commit, push, stacked PR, or after integrating a base branch. For documentation-only changes, check affected links and artifacts."
---

# Verificar SIPGES

Mientras iteras y antes de cada push, ejecuta `corepack pnpm verify:fast`: lint, límites y tipos en paralelo, y después las pruebas de los paquetes que cambiaron desde `origin/main` (base configurable con `SIPGES_VERIFY_BASE`), de a uno porque la API usa PGlite y necesita memoria. La suite completa la corre la CI en 8 jobs paralelos; sin GitHub Pro, `main` no exige esos checks, así que **no mergees sin los 8 en verde** (`sipges-ci-triage`).

Usa la suite completa local, `corepack pnpm verify`, solo cuando cambies configuración compartida (raíz, `packages/*` de los que dependen todos, CI) o cuando la CI no esté disponible. Desde la raíz, `corepack pnpm verify` propaga el estado de `pnpm check`: lint, formato, límites de dependencias, tipos y pruebas. Una comprobación fallida impide afirmar que el cambio está verificado.

Para PostgreSQL real, proporciona `SIPGES_TEST_DATABASE_URL` de un servidor **sintético** autorizado. El script no arranca servicios ni supone credenciales. Sin esa variable, las pruebas opcionales PostgreSQL quedan omitidas; PGlite sigue comprobándose. No imprimas la URL ni sus secretos.

Si hay cambios web, ejecuta `corepack pnpm --filter @sipges/web build`. Si existe `apps/e2e` y cambian flujos de usuario, ejecuta `corepack pnpm e2e`. Estas operaciones no migran datos reales ni despliegan.

En un cambio exclusivamente documental, comprueba enlaces y artefactos afectados. Archify usa `sipges-archify`; no repitas una suite aprobada si no cambió código ni apareció una preocupación nueva.

Ante un fallo, identifica su causa, corrige y vuelve a comprobar lo afectado. Formatea archivos concretos con `corepack pnpm exec prettier --write <archivos>`. No elimines pruebas ni añadas excepciones para obtener verde.

Entrega comandos, resultados, conteos por paquete y si PostgreSQL real se ejecutó. Distingue resultados locales de CI y comprobaciones omitidas.

Referencia: [skills oficiales de Codex](https://developers.openai.com/codex/skills/). Scripts: `scripts/verify.sh`, `package.json`; CI: `.github/workflows/ci.yml`.
