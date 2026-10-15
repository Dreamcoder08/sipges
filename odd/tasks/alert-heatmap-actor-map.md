# Clasificación de alertas y mapa de actores

## Especificación

- S1 (2026-10-15): las referencias facilitadas por el titular muestran una matriz de calor por dimensión MASCLI y comunidad, y un mapa circular de actores con agrupaciones y anillos. Implementar estas visualizaciones en las pantallas existentes, manteniendo las tablas y fichas.
- S2: usar los registros del proyecto activo y sus filtros. No crear ubicaciones, relaciones, niveles, porcentajes o series temporales para imitar los valores de las imágenes.
- S3: la matriz muestra el nivel máximo documentado por dimensión y territorio entre alertas activas. Cerradas y descartadas permanecen consultables en la tabla. Sin registros es «Sin datos»; registros sin nivel son «Sin nivel». Un territorio se toma del campo de la alerta o de una referencia exacta a un evento accesible del mismo proyecto. Una referencia ambigua o narrativa no asigna territorio.
- S4: el diagrama agrupa por tipo e influencia almacenados. La distancia representa las categorías ordinales Alta, Media-alta, Media, Media-baja y Baja; no son coordenadas geográficas ni puntajes nuevos. El color interpreta posiciones explícitas conocidas; los valores no clasificables permanecen visibles en sus fichas. Los grupos permiten abrir los registros y consultar sus relaciones documentadas.
- S5: mantener el acceso con usuario y contraseña solicitado anteriormente, los roles y RLS existentes. Esta tarea no migra, elimina ni reclasifica registros almacenados. La limpieza de demostración ya integrada en main se conserva.

## Implementación

Modelos puros en `features/records/insights`, componentes SVG y tabla accesible sin dependencias nuevas. Consumen las mismas consultas paginadas que la tabla; el único cruce adicional es la lectura autorizada de eventos para referencias explícitas de alertas. Los fallos de esa consulta se muestran con reintento. Actores sin clasificación no se omiten. Los mapas y fichas conservan navegación y foco con identificadores importados.

La consulta de estructura disponible el 15 de octubre encontró nueve alertas: cinco con una referencia exacta a un evento que aporta territorio. Las otras cuatro requieren completar o verificar su territorio; no se deduce de la causa escrita. El campo opcional Comunidad / territorio permite registrarlo manualmente cuando se disponga de información verificada.

## Verificación

Pruebas de modelos: máximos, niveles desconocidos, dimensiones desconocidas, referencias exactas y prioridad del territorio explícito. Pruebas de interfaz: apertura y retorno de fichas, foco y acceso de consulta. Playwright contra API y persistencia PGlite aislada: creación, clasificación y lectura de fichas en escritorio y 390 px; capturas de datos de prueba separadas de producción. Resultados definitivos en `docs/qa/integral-functional-audit.md`.

Gate final aprobado: API 578, web 195 y verificaciones completas con PostgreSQL aislado; nuevos flujos Chromium 2/2 y WebKit 5/5 (incluye concesiones, informes y directorio). Capturas revisadas en escritorio y móvil; etiquetas inferiores separadas y leyenda coherente con los nodos. Sin operaciones de negocio en producción.
