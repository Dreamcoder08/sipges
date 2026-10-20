# ADR 0026: vista 3D del territorio sobre MapLibre + deck.gl

- Estado: aceptada
- Fecha: 2026-10-20
- ODD: `odd/tasks/territorial-3d.md`
- Amplía ADR 0017 (motor cartográfico); se apila sobre ADR 0025 (PR #71).

## Contexto

La fase 5 de la hoja de ruta territorial pedía una vista 3D, con CesiumJS como candidato. El
mapa ya corre en MapLibre GL JS con una capa deck.gl (ADR 0017), que admite inclinación,
rotación y capas extruidas sin nada nuevo. CesiumJS sería un segundo motor de varios MB, con
su propio ciclo de datos y estilos, y su relieve de calidad depende de Cesium ion, un servicio
con token. El relieve de Sechura es bajo y casi todo el desierto costero está cerca del nivel
del mar. Además, las capas deck.gl superpuestas no se apoyan sobre un relieve de MapLibre, así
que un punto quedaría desplazado de su lugar real en las lomas.

## Decisión

- Botón «Vista 3D» en el mapa WebGL (con `aria-pressed`): inclina la cámara 55°, habilita
  girar e inclinar (botón derecho, dos dedos, Mayús + flechas) y añade «Norte arriba». Al
  apagarlo, el mapa vuelve a 0° y sin rotación.
- Los registros visibles se agrupan en celdas de 0,01° (unos 1,1 km). Cada celda se dibuja como
  una columna `ColumnLayer` cuya altura es el número de registros, con 8 px por registro a
  cualquier zoom. El color es el de la dimensión con más registros. La columna es sólida si
  todos tienen coordenadas explícitas y más clara si alguno está ubicado en su localidad.
- Los escenarios no suman altura. Los puntos siguen dibujados encima de las columnas, sin
  prueba de profundidad, para que todo registro siga visible y seleccionable.
- No se añade relieve ni otra fuente de teselas, así que no cambian la CSP ni las dependencias.
  El mapa SVG de respaldo sigue en 2D.

## Consecuencias

La vista 3D muestra concentración documentada, no impacto, propagación ni pronóstico, y respeta
los filtros, la reproducción temporal y los estados Observado y Estimado. CesiumJS y el relieve
quedan para cuando haga falta terreno real, por ejemplo cuencas o pendientes, con una fuente
de elevación abierta, verificable y declarada en la CSP.
