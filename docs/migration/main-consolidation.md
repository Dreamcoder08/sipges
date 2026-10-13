# Consolidación del runtime TypeScript

La rama `chore/typescript-main-consolidation` integra la cadena T8–T14, las skills/scripts y los controles de seguridad de ADR 0009 sobre `main`, conservando la ascendencia Git de los PR. La fusión se realiza después de comprobar la integración.

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

La suite completa de integración y la CI del PR deben comprobarse antes de fusionar. Los tres casos de cookies con `mascli-e2e.test` siguen sujetos al bloqueo de red del entorno local; se ejecutan sin excepciones en GitHub Actions.

## Primera publicación

Demo académica/personal, datos sintéticos y subdominio gratuito del proveedor. No se compra dominio ni se migran datos reales. La disponibilidad de las credenciales de PostgreSQL y del almacenamiento debe comprobarse antes de anunciar una URL funcional; el estado de CI no equivale a un despliegue.
