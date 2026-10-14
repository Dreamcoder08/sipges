# Consolidación del runtime TypeScript

La rama `chore/typescript-main-consolidation` integra la cadena T8–T14, las skills/scripts y los controles de seguridad de ADR 0009 sobre `main`, conservando la ascendencia Git de los PR. El PR #24 se fusionó en `main` con el commit `a9c80574886c322d9f1ad3b2536a7768bcb056ad`, después de aprobar la CI completa.

## Comportamiento integrado

MFA es obligatorio por defecto. El primer acceso redirige a `/mfa`, donde cualquier usuario autenticado, incluido el rol consulta y sin proyecto seleccionado, puede configurar su autenticador. Un código incorrecto conserva la configuración para reintentar; al activarlo se elimina la clave de la pantalla y se vuelve al dashboard. Cada escritura verifica el origen y la lista de hosts limita las peticiones cuando está configurada.

La integración detectó que las cabeceras de ADR 0009 sobrescribían la CSP de la SPA y bloqueaban su JavaScript. Se conserva ahora la política específica de la SPA y se aplica la política restrictiva de API a las otras respuestas. La prueba de navegador falló antes de la corrección y después aprobó el alta MFA y un segundo inicio de sesión con código.

El arranque actual es `node apps/api/src/main.ts` tras compilar la SPA. Python, sus estáticos, requisitos y archivos de despliegue antiguos viven en `reference/python`, exclusivamente como referencia de paridad. CI y el generador de fixtures apuntan a esa ubicación. No se leen ni migran datos operacionales.

## Evidencia disponible

- PR 22 (skills/scripts): CI aprobada en el commit `fdedac3`.
- PR 23 (T14): CI aprobada en el commit `0af0e44`, incluidas las 28 pruebas E2E originales con PostgreSQL real.
- Integración: 99 pruebas web aprobadas; build de Vite aprobado.
- `03-mfa-required.spec.ts`: alta MFA obligatoria y siguiente login aprobados en Chromium local.
- Referencia congelada: 40 pruebas pytest aprobadas tras el traslado.

La verificación final local `pnpm verify` aprobó 439 pruebas API (7 PostgreSQL opcionales omitidas), 99 web, 3 kernel, 3 limpieza E2E y 4 herramientas. E2E local: 26 aprobadas y tres bloqueadas por red. La [CI de #24](https://github.com/Dreamcoder08/mascli/actions/runs/38472258557) aprobó el código final con PostgreSQL real y las 29 pruebas E2E.

Se cerraron los diez PR apilados ya incorporados y se eliminaron 23 ramas remotas después de comprobar su ascendencia respecto a main. El [manifiesto](merged-branches.json) conserva nombres y revisiones; todos esos commits son alcanzables desde main. La rama predeterminada antigua se conserva porque el token rechazó el cambio de configuración con HTTP 403. El permiso requerido por GitHub es `administration:write`; la integración actual no lo tiene. Para que la portada no quede en Python, la rama predeterminada antigua se sincronizó por avance rápido con el commit de main, sin reescribir historial. El nombre predeterminado sigue pendiente. Los tres casos de cookies con `mascli-e2e.test` siguen sujetos al bloqueo de red del entorno local; se ejecutan sin excepciones en GitHub Actions.

## Primera publicación

Demo académica/personal, datos sintéticos y subdominio gratuito del proveedor. No se compra dominio ni se migran datos reales. La disponibilidad de las credenciales de PostgreSQL y del almacenamiento debe comprobarse antes de anunciar una URL funcional; el estado de CI no equivale a un despliegue.
