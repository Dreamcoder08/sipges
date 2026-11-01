# ADR 0026: terreno 3D con CesiumJS y elevación abierta

- Estado: aceptada
- Fecha: 2026-10-20
- ODD: `odd/tasks/territorial-3d.md`
- Amplía ADR 0017 (motor cartográfico); se apila sobre ADR 0025 (PR #71).

## Contexto

La fase 5 de la hoja de ruta territorial pide terreno 3D con CesiumJS y relieve. CesiumJS es
código abierto (Apache 2.0); lo que es de pago es Cesium ion, el servicio de teselas que usa por
defecto para relieve e imágenes. Las capas deck.gl sobre MapLibre no se apoyan en un relieve
elevado, así que un punto quedaría desplazado de su lugar en las lomas. La aplicación tiene una
CSP estricta: sin estilos en línea, sin `eval` y sin compilar WebAssembly.

## Decisión

- El mapa WebGL 2D (MapLibre + deck.gl) sigue siendo el principal. Su botón «Vista 3D» carga
  bajo demanda `@cesium/engine` 26.3.0 (solo el motor, sin los widgets) en un fragmento propio,
  y «Vista 3D» (`aria-pressed`) en esa vista vuelve al 2D.
- El relieve sale de Terrain Tiles de Mapzen en AWS Open Data (codificación Terrarium, sin clave,
  crédito en el pie del mapa). Un `CustomHeightmapTerrainProvider` las decodifica en el
  navegador en mallas de 65 × 65 alturas, sobre la misma teselación Web Mercator, y recorta las
  teselas más profundas de su ancestro en el nivel 14. Se exagera 1,5 veces. Si una tesela no se
  puede leer, esa zona queda plana y la página lo indica.
- Las imágenes del mapa base son las mismas del 2D (OSM o Sentinel-2 de EOX). Sin mapa base, el
  suelo se colorea por altura, de 0 a 600 m.
- Concesiones, distritos y registros se apoyan en el terreno. Los registros se ven siempre,
  incluso detrás de lomas o columnas, y se eligen con un clic como en el 2D. Los registros
  documentados de cada celda de 0,01° (unos 1,1 km) suben como una columna de 400 m por registro.
  La columna es sólida si todos tienen coordenadas explícitas, y los escenarios no suman altura.
- No se usa Cesium ion. El crédito por defecto (el logotipo de ion) se sustituye por un enlace a
  CesiumJS.
- Cesium carga sus workers y recursos desde `/cesium/`. La compilación los copia de
  `@cesium/engine` y la API los sirve con la CSP de la aplicación (`spa.ts`), igual que Vercel
  (`vercel.json`). La CSP solo añade `https://s3.amazonaws.com` a `connect-src`.
- Para cumplir la CSP sin relajarla, `vite.config.ts` cambia dos líneas de Cesium. Una prueba de
  capacidades fija un estilo con atributo y ahora lo hace por el CSSOM; la hoja de estilo que
  inyecta el bloque de créditos se omite. Además, `meshoptimizer` (glTF comprimido, que SIPGES no
  carga) se sustituye por un decodificador inerte, porque compilaba WebAssembly al importarse.
  Si una versión de Cesium mueve esas líneas, la compilación falla.

## Consecuencias

El fragmento de Cesium pesa unos 3,9 MB (1 MB comprimido) y `dist/cesium/` unos 7,5 MB; solo se
descargan al abrir la vista 3D. Al abrirla, el navegador pide a AWS las teselas de elevación de
la zona visible. La vista muestra relieve y concentración documentada, no impacto, propagación ni
pronóstico, y respeta los filtros, la reproducción temporal y los estados de la información. Sin
WebGL 2, o si Cesium falla, la página vuelve al mapa 2D y lo explica.
