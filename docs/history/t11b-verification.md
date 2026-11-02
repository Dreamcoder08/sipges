# Verificación T11b · registros territoriales y evidencias

Fecha: 2026-10-13. Rama: `feat/typescript-migration-11b-records-ui`. Los datos usados son sintéticos y están aislados del repositorio; no se migraron registros reales ni se desplegó la aplicación.

## Flujos comprobados

| Límite | Evidencia |
| --- | --- |
| Interfaz → API | Creación desde navegador real de eventos, actores, directorio, demandas, narrativas, fuentes y compromisos |
| API → datos → interfaz | Registros persistidos en PGlite y listas actualizadas; edición conserva campos adicionales y vínculos de adjuntos |
| Archivos | Multipart real, metadatos SQL, descarga cuyo contenido coincide con los bytes originales |
| Tenancy | Cambio entre dos proyectos autorizados; el registro de un proyecto no aparece en el otro; pruebas de guardado y carga en curso con alcance original fijado |
| Permisos y errores | Roles de consulta/coordinador sin escrituras; 403 conserva borradores, 413 conserva archivo para reintento, 410 explica una descarga ausente y 401 devuelve al acceso |
| Formularios | Valores de selección importados, aliases de directorio, borrado persistente de teléfono importado y confirmación/cancelación de eliminación |
| Navegador | Chromium, interfaz y API del mismo origen, sin errores JavaScript; captura móvil de 390×844 sin desbordamiento horizontal de página |

Las [capturas de evidencias en escritorio](assets/t11b-evidence-desktop.png) y [registros en móvil](assets/t11b-records-mobile.png) se revisaron visualmente. La tabla móvil permite desplazamiento horizontal dentro de su región accesible.

## Revisión independiente y regresiones

La revisión encontró tres fallos: controles que permitían cambiar de editor durante un guardado, pérdida del nombre del proyecto al editar y recuperación de aliases después de limpiar un campo. Las tres pruebas fallaron antes de corregir el código y pasaron después. Otra regresión bloquea la edición/eliminación mientras una evidencia está subiendo.

Se conservan dos diferencias de paridad menores: clasificación explícita de dimensión en eventos y aliases de directorio enumerados. Se documentan en [la guía web](../migration/web.md); no se afirma paridad completa de todas las pantallas. Esa verificación pertenece a T14.

## Resultado de la comprobación final

`corepack pnpm check` pasó: lint, límites de arquitectura (258 módulos / 628 dependencias), tipos y pruebas. API: 382 pasaron / 6 omitidas; web: 46 pasaron; kernel: 3 pasaron. Total: 431 pruebas aprobadas. Las seis omitidas son la integración opcional con PostgreSQL real.

`corepack pnpm --filter @sipges/web build` pasó; bundle de aproximadamente 145 kB gzip. No se incorporaron nuevas dependencias.

## Reproducir las comprobaciones del workspace

```bash
corepack pnpm install --frozen-lockfile
corepack pnpm check
corepack pnpm --filter @sipges/web build
```

Las pruebas HTTP de interfaz usan MSW y contratos reales; las pruebas de API usan PGlite. Los flujos de navegador adicionales se ejercitaron contra el build de la SPA servido por Hono, con un directorio temporal nuevo para PGlite y evidencias. Las seis pruebas opcionales con PostgreSQL real se omiten cuando no se configura `SIPGES_TEST_DATABASE_URL`; la comprobación con PGlite no sustituye esa integración.
