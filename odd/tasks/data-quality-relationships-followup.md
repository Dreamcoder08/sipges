# Calidad de datos, relaciones documentadas y seguimiento

## Especificación

- S1 (2026-10-15): continuar con ODD e implementar las mejoras aprobadas: clasificación verificable, relaciones con fuente, responsables y vencimientos, recuperación de informes y validación de recorridos completos.
- S2: no deducir territorios, posiciones, fechas ni relaciones de narrativas. No modificar datos reales para completar indicadores. Una referencia existente no acredita por sí sola la veracidad del contenido.
- S3: mostrar una cola de revisión del proyecto autorizado con regla, registro y acceso a su ficha editable. Distinguir campos ausentes, valores no clasificables y fuentes no resolubles por el usuario. Recalcular después de guardar.
- S4: las relaciones explícitas admiten fuente documental accesible y auditable. Conservar vínculos anteriores sin fuente, distinguiéndolos de inferencias. Mantener autorización y RLS, incluyendo fuentes restringidas.
- S5: los vencimientos requieren fechas de calendario válidas; no interpretar plazos narrativos. El día operativo es America/Lima. No contar registros cerrados ni fechas vacías como atrasos. Conservar el plazo original.
- S6: inventariar metadatos de informes existentes sin afirmar que sus bytes se recuperaron. Abrir los visores existentes para comprobar disponibilidad. No reemplazar documentos ausentes por resúmenes o archivos nuevos.
- S7: probar flujos de lectura, corrección, persistencia y permisos con datos de prueba aislados. La aceptación de una usuaria real y la recuperación de originales ausentes permanecen pendientes hasta disponer de evidencia.

## Diseño y plan

Se conserva React/TanStack, Hono, contratos Zod, PostgreSQL y la arquitectura por contextos. No se incorporan dependencias de ejecución externas. La pantalla de calidad pertenece a la funcionalidad de registros y utiliza sus consultas autorizadas. La ficha 360 permite corregir campos mediante el editor y la persistencia existentes. Las relaciones incorporan una migración aditiva nullable; desplegar primero esquema y después aplicación. Para revertir la aplicación se conserva la columna y sus datos, sin borrado ni backfill automático.

Trabajo independiente: trazabilidad de relaciones en contratos/contexto ontológico/LinksPanel; calendario y seguimiento en kernel/contexto gerencial/panel aislado; integración, calidad e inventario en la composición web. La revisión final comprobará los contratos e interacciones entre los tres.

## Tareas

- T1 [x] — Cola de calidad y corrección persistente desde la ficha. commit: see L4
- T2 [x] — Fuentes documentales de relaciones, permisos y auditoría. commit: see L5
- T3 [x] — Seguimiento con fechas válidas y responsables. commit: see L6
- T4 [x] — Inventario verificable y recorridos de informes existentes. commit: see L7
- T5 [x] — Pruebas integradas, revisión y PR. commit: see L8
- T6 [ ] — Verificar clasificaciones pendientes con sus fuentes originales, recuperar documentos ausentes y realizar la aceptación con una usuaria real. commit: pending (bloqueo externo; no sustituir por pruebas automatizadas)

## Registro

- L1 (Diagnóstico): diagnóstico inicial sobre main `3099e11`: `management/domain/overview.ts` compara fechas vacías lexicográficamente; `record_links` no documenta una fuente propia; la ficha 360 es de consulta aunque el editor existente permite conservar campos importados. Las cuatro alertas sin territorio del ODD anterior siguen requiriendo evidencia humana. No se han reclasificado ni importado registros.

- L2 (Revisión): revisión independiente corrigió tres interacciones: día UTC frente a America/Lima, fechas nuevas preseleccionadas y resurrección de alias al borrar. Una prueba adicional reproduce una edición de responsable que perdía un plazo ISO; el formulario conserva ahora la fecha efectiva sin interpretar texto libre. El historial privado registra las transiciones de fuente sin exponer sus identificadores mediante la auditoría general.

- L3 (Compatibilidad de navegador): WebKit 1.56.1 cerraba el renderizador nativo en dos recorridos de recarga, incluso sin subir un archivo y con más memoria. La misma secuencia completa aprueba 7/7 con Playwright 1.63.0 y su imagen Noble compatible; se actualiza solo la herramienta de pruebas y CI incorpora estos siete casos, sin omitir acciones ni relajar CSP o permisos.
- L4 (Calidad y edición): Cola de revisión autorizada con reglas, búsqueda, filtros, paginación y acceso a edición desde ficha 360; guarda conservando campos importados e invalida las consultas. Pruebas web de calidad y ficha, recorrido real Chromium y WebKit de corrección/persistencia y móvil aprobados. No se dedujeron clasificaciones reales. Evidencia y entrega: https://github.com/Dreamcoder08/mascli/pull/52.
- L5 (Fuente de relaciones): Fuente opcional en contratos, API y editor, validación transaccional del mismo proyecto con RLS, estados disponible/no disponible/sin documentar e historial privado append-only. Pruebas PostgreSQL de lectura restringida y recuperación por operador sin BYPASSRLS aprobadas; recorrido real abre la fuente de la relación. Migración aditiva, sin borrar asociaciones anteriores. Evidencia y entrega: https://github.com/Dreamcoder08/mascli/pull/52.
- L6 (Seguimiento verificable): Calendario estricto y día America/Lima; fechas opcionales, alias controlados, plazos narrativos conservados y edición sin pérdida. Panel de vencidos/hoy/próximos/sin fecha/sin responsable y filtros reales. Pruebas de regresión de fecha vacía, UTC, borrado y edición de responsable aprobadas, además del recorrido de API y navegador. Evidencia y entrega: https://github.com/Dreamcoder08/mascli/pull/52.
- L7 (Inventario de informes): Inventario de metadatos accesibles con fuentes y fichas; declara el límite de 500 adjuntos y no equipara metadatos a bytes recuperados. Los recorridos de escritorio/móvil suben y abren un archivo de prueba por API y visor reales. No se localizaron originales recuperables en el workspace; su recuperación permanece en T6, sin sustituciones inventadas. Evidencia y entrega: https://github.com/Dreamcoder08/mascli/pull/52.
- L8 (Verificación y PR): 818 pruebas de paquetes aprobadas (API 586 con PostgreSQL aislado, web 211, kernel 8, hosting 6, limpieza E2E 3, herramientas 4), lint/formato/límites/tipos y build de hosting aprobados. Suite Chromium completa anterior: 87 aprobadas y una captura opcional preexistente omitida. Playwright 1.63.0: nuevos recorridos Chromium 2/2 y WebKit 7/7; CI incorpora WebKit. Revisión independiente sin hallazgos importantes pendientes. PR publicado; CI remota y comprobación de despliegue se registrarán allí antes de declarar publicación. Aceptación humana pendiente en T6. Evidencia y entrega: https://github.com/Dreamcoder08/mascli/pull/52.

La publicación en producción y su comprobación de lectura se registrarán en el PR de entrega, vinculado desde la evidencia de T5, después de comprobar el commit y el entorno de Vercel. El despliegue no constituye aceptación humana ni recupera por sí solo documentos ausentes.
