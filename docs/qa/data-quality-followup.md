# Calidad, trazabilidad y seguimiento: evidencia y aceptación

## Alcance

ODD: `odd/tasks/data-quality-relationships-followup.md`. La revisión compara únicamente registros accesibles del proyecto activo. Sus observaciones no son una calificación científica ni verifican automáticamente hechos. Una fuente accesible acredita la referencia, no la veracidad del contenido.

## Informes originales

La búsqueda actual de artefactos recuperables en el workspace no localizó informes originales del proyecto; solo apareció una plantilla de la dependencia de pruebas Python. No se leyeron `data/seed.json` ni bases de datos locales. El inventario de la aplicación permite revisar los metadatos autorizados y abrir cada ficha para comprobar sus bytes mediante el visor. La consulta global de adjuntos se limita a 500 metadatos: se indica expresamente y no se interpreta una ausencia como pérdida del archivo. No se reemplazaron ni regeneraron originales.

## Migración reversible

`0020_link_evidence.sql` añade una columna nullable a las relaciones. No reclasifica ni borra registros. Desplegar las migraciones antes de servir el API nuevo. Una reversión de aplicación conserva la columna y las asociaciones; no ejecutar DROP ni intentar reconstruir fuentes a partir de notas. Las relaciones anteriores siguen sin fuente documentada hasta su revisión. El historial privado conserva antes/después, actor y fecha incluso si se elimina el vínculo; la aplicación solo puede añadir filas. La recuperación por el propietario de la base requiere seleccionar explícitamente el tenant en una transacción; no hay un endpoint público ni se desactiva RLS. La fuente restringida o eliminada se presenta como no disponible sin revelar identificadores ni títulos.

## Aceptación con usuaria real — pendiente

Estos casos están preparados para una sesión con la usuaria; no se certifica su ejecución humana mediante pruebas automatizadas.

| Recorrido | Resultado esperado | Estado |
| --- | --- | --- |
| Abrir Calidad y buscar una alerta sin territorio | Explica el campo pendiente y abre su ficha; no deduce una comunidad de la causa | Pendiente usuaria |
| Documentar territorio desde ficha 360° y guardar | Persiste, mantiene campos importados y desaparece la observación correspondiente | Pendiente usuaria |
| Consultar relación actor/compromiso | Distingue inferencia de vínculo explícito y abre su fuente cuando es accesible | Pendiente usuaria |
| Cambiar responsable y fecha límite | Mantiene plazo original y actualiza filtros vencido/hoy/próximo | Pendiente usuaria |
| Abrir informe original desde su fuente | Contenido y metadatos corresponden al original, o error de disponibilidad explícito | Bloqueado donde falta el original |
| Repetir con rol consulta y móvil | Lee fichas sin controles de escritura, navegación y tablas utilizables | Pendiente usuaria |

## Resultados automatizados

Verificación local del 15 de octubre de 2026:

| Comprobación | Resultado |
| --- | --- |
| `pnpm verify`, API | 586 pruebas / 77 archivos aprobados, con conexión PostgreSQL de prueba explícita |
| Web tras corregir la aserción antigua de compromisos | 211 pruebas / 50 archivos aprobados |
| Kernel / hosting / soporte E2E / herramientas | 8 / 6 / 9 / 4 aprobadas |
| Lint, formato, límites y tipos de todos los paquetes | Aprobados; 604 módulos, 1725 dependencias |
| `pnpm --filter @mascli/hosting build` | Aprobado; incluye el build web |
| Suite completa Chromium, Playwright 1.56.1 | 87 aprobadas; 1 captura opcional preexistente omitida |
| Nuevos recorridos Chromium, Playwright 1.63.0 | 2/2 aprobados contra API y persistencia reales de prueba |
| WebKit, Playwright 1.63.0 / imagen Noble correspondiente | 7/7 aprobadas; incluye escritorio y móvil, recarga y lectura de bytes |
| Revisión de código independiente | Sin hallazgos críticos o importantes pendientes |

La primera suite web detectó una aserción ambigua porque el compromiso se muestra tanto en el seguimiento como en la tabla. La aserción consulta ahora explícitamente la tabla, conservando la comprobación de su fila; la suite completa se ejecutó de nuevo con 211/211. Después de revisar capturas se completaron las etiquetas de las tablas móviles y se volvieron a comprobar los 10 casos afectados, tipos, lint y build. El build conserva un aviso de tamaño del bundle principal mayor de 500 kB, sin error de compilación.

Las pruebas de archivos emplean documentos de prueba aislados y no sustituyen la recuperación de originales. La suite WebKit anterior (1.56.1) aprobó cinco casos y sufrió dos cierres nativos del renderizador al recargar una ficha; no se encontraron errores JavaScript asociados. Se reprodujo sin subida de archivo y con más memoria compartida. La misma secuencia completa aprueba con Playwright 1.63.0 y su imagen Noble correspondiente. Se actualizó exclusivamente la dependencia de pruebas y se incorporaron esos siete recorridos a CI; no se atribuye el fallo a un defecto de aplicación ni a una incidencia upstream concreta sin evidencia. No se omitieron recargas, permisos, CSP ni comprobaciones del visor.

La primera CI del PR (`362a215`) aprobó las 818 pruebas de paquetes, pero Chromium 1.63.0 dejó tres recorridos pendientes en el monitor de red. Las trazas distinguen precargas abandonadas del documento anterior (sin respuesta terminal) de las respuestas 200 de la página nueva. El monitor descarta solo peticiones anteriores a una navegación principal cuando esta se confirma, conservando la navegación y sus recursos. Se añadieron seis regresiones: reproducción roja del abandono y comprobaciones de recursos actuales, navegación interna, subframes, navegación fallida y SSE. Las nueve pruebas de soporte E2E y los seis recorridos de CSP/pantallas/roles aprobaron tras la corrección; el total de paquetes pasa a 824. Se mantienen los controles independientes de errores del navegador y CSP. La CI definitiva del commit corregido se registra en el PR antes de integrar.
