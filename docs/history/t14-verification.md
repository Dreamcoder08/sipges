# Verificación de T14

2026-10-13. PR #23 sobre T13; skills/scripts permanecen en PR #22.

La CI original de T14 (`38466902005`) aprobó TypeScript, pruebas Python de referencia y 28 pruebas Chromium sobre PostgreSQL 17. Se revisaron cookies, MFA, aislamiento, evidencias, informes, CSP y móvil.

La ejecución local Chromium sobre PGlite produjo 25 aprobadas y tres fallos. Las tres pruebas de cookies sobre el hostname deliberadamente no confiable `mascli-e2e.test` fueron bloqueadas por el proxy del entorno, con `No approved upstream IPv4 address`. No se cambió la política de red ni se omitieron pruebas para afirmar una suite verde. Esta limitación local se distingue de la CI aprobada.

La revisión independiente encontró una fuga del harness ante fallo de arranque: no devolvía teardown y podía dejar la base temporal, conexión y directorio abiertos. Tres regresiones fallaron antes de implementar `usingCleanup`; después pasaron. Los recursos se registran al adquirirlos y se liberan en orden inverso; un fallo de limpieza no impide liberar los demás; se preservan errores originales y la limpieza drenada es idempotente. El revisor volvió a comprobar y aprobó la corrección.

`corepack pnpm check` local aprobado: lint/formato, dependencias, tipos, API 418 aprobadas / 7 opcionales PostgreSQL omitidas, web 98, kernel 3 y tres pruebas del harness. Esta actualización se vuelve a comprobar en la CI del PR.

No se desplegó ni se migraron datos reales en T14. La demo académica gratuita con datos sintéticos, integración en main y retirada del runtime legado son pasos posteriores autorizados por el usuario.
