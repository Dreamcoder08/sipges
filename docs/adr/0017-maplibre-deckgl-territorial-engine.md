# ADR 0017: motor cartográfico MapLibre GL JS + deck.gl

- Estado: aceptada
- Fecha: 2026-10-18
- ODD: `odd/tasks/geospatial-timeline-intelligence.md`
- Amplía ADR 0006 (frontend) y ADR 0016; conserva ADR 0002, 0004 y 0009.

## Contexto

El mapa territorial dibujaba marcadores SVG sobre teselas raster y el catastro de INGEMMET como
una imagen exportada. Las concesiones no se podían seleccionar ni analizar, y cada gesto movía
cientos de nodos del DOM. La API ya consulta INGEMMET con destinos fijos y límites de tamaño.

## Decisión

El mapa territorial usa MapLibre GL JS 6 para el mapa base raster (OSM o Sentinel-2 de EOX, los
mismos servicios) y deck.gl 9 (`MapboxOverlay`, no intercalado) para lo que dibuja MASCLI:
distritos, concesiones (`GeoJsonLayer`) y registros (`ScatterplotLayer`). Es un adaptador de
`features/geography/engine`: recibe datos ya preparados y devuelve clics y la vista asentada; el
dominio, los contratos, Hono y TanStack Query no cambian.

- Se carga en un fragmento diferido solo en `/mapa`. El worker de MapLibre se publica como módulo
  del mismo origen (`?worker&url`), sin workers `blob:`.
- CSP: `connect-src` admite los dos hosts de teselas (MapLibre las descarga con fetch) e
  `img-src` admite `blob:`. No se permite `eval`. El módulo del motor no importa los contratos,
  para que zod siga en el fragmento de entrada después de su configuración `jitless`.
- Sin WebGL 2, o si el motor falla o pierde el contexto, se dibuja el renderizador SVG anterior con
  las mismas capas y acciones.
- Las concesiones de la vista (máximo 2,5° y 200 por consulta) se piden a la API existente; los
  anillos Esri se convierten a GeoJSON en el cliente. La relación con registros MASCLI sigue
  siendo la del servidor: coordenadas explícitas o referencia documentada al código. Un polígono
  oficial que excede el contrato no se simplifica.
- Los estados de información Observado, Estimado y Escenario hipotético se derivan del registro
  (verificación, fuente, declaración explícita); no hay propagación ni predicción.

## Consecuencias

El fragmento del motor pesa unos 490 kB comprimidos y solo se descarga en el mapa territorial.
CesiumJS (3D) y PostGIS (proximidad, áreas de influencia) quedan para fases posteriores. Las
pruebas jsdom ejercitan el renderizador SVG; Playwright en Chromium ejercita el motor WebGL.
