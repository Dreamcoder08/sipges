---
name: mascli-verify
description: "Use when MASCLI code, scripts or configuration must be verified before a commit, push, stacked PR, or after integrating a base branch. For documentation-only changes, check affected links and artifacts."
---

# Verificar MASCLI

Desde la raíz, ejecuta `corepack pnpm verify`. El script propaga el estado de `pnpm check`: lint, formato, límites de dependencias, tipos y pruebas. Una comprobación fallida impide afirmar que el cambio está verificado.

Para PostgreSQL real, proporciona `MASCLI_TEST_DATABASE_URL` de un servidor **sintético** autorizado. El script no arranca servicios ni supone credenciales. Sin esa variable, las pruebas opcionales PostgreSQL quedan omitidas; PGlite sigue comprobándose. No imprimas la URL ni sus secretos.

Si hay cambios web, ejecuta `corepack pnpm --filter @mascli/web build`. Si existe `apps/e2e` y cambian flujos de usuario, ejecuta `corepack pnpm e2e`. Estas operaciones no migran datos reales ni despliegan.

En un cambio exclusivamente documental, comprueba enlaces y artefactos afectados. Archify usa `mascli-archify`; no repitas una suite aprobada si no cambió código ni apareció una preocupación nueva.

Ante un fallo, identifica su causa, corrige y vuelve a comprobar lo afectado. Formatea archivos concretos con `corepack pnpm exec prettier --write <archivos>`. No elimines pruebas ni añadas excepciones para obtener verde.

Entrega comandos, resultados, conteos por paquete y si PostgreSQL real se ejecutó. Distingue resultados locales de CI y comprobaciones omitidas.

Referencia: [skills oficiales de Codex](https://developers.openai.com/codex/skills/). Scripts: `scripts/verify.sh`, `package.json`; CI: `.github/workflows/ci.yml`.
