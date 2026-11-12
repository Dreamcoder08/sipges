# ADR 0025: áreas de influencia con PostGIS

- Estado: aceptada
- Fecha: 2026-10-19
- ODD: `odd/archive/geospatial-analysis.md`
- Amplía ADR 0017 (motor cartográfico) y ADR 0022 (expediente operacional); conserva ADR 0003.
- Numeración: 0023 y 0024 corresponden a otros PR abiertos.

## Contexto

La fase 4 de la hoja de ruta territorial pide consultar relaciones espaciales reales con
PostGIS: proximidad y áreas de influencia alrededor de una concesión. La relación vigente solo
reconoce registros dentro del polígono oficial o con referencia documentada a su código. La base
de producción (Neon) y PGlite de desarrollo no tienen PostGIS instalado, y la CI usaba la imagen
`postgres:17`.

## Decisión

- `POST /system/geography/query` acepta `influenceMeters` (0 a 20 000) junto al polígono. Los
  registros con coordenadas propias fuera del polígono y a esa distancia o menos del límite se
  devuelven como relación `proximity`, con `distanceMeters`, del más cercano al más lejano. La
  respuesta indica el ancho y el motor de medición en `influence`.
- Puerto `SpatialEngine` en el contexto de geografía. El adaptador PostGIS calcula
  `ST_Distance` entre `geography` construidos en la propia consulta a partir del polígono y de
  los puntos ya leídos bajo RLS: no lee ni escribe tablas, así que el aislamiento y las marcas
  siguen en el lector de registros.
- La aplicación no crea la extensión ni requiere migración. Comprueba `pg_extension` cada diez
  minutos; sin PostGIS, o si la consulta falla, responde una aproximación geodésica en proceso
  (plano tangente en el punto), que la ficha declara como aproximada. Ambas coinciden dentro del
  1 % en la prueba con PostGIS real.
- La CI de TypeScript usa `postgis/postgis:17-3.5`; la prueba crea la extensión solo en su base
  desechable. Habilitarla en Neon es un paso manual documentado en
  `docs/deployment/territorial-intelligence.md`.
- La ficha ofrece 1, 3, 5 y 10 km; el expediente operacional y el filtro «solo vinculados»
  incluyen esos registros.

## Consecuencias

Una localidad escrita nunca ubica un registro en un área de influencia, y la cercanía no se
presenta como impacto. Intersecciones entre concesiones, cuencas y otras capas oficiales quedan
para cuando haya una necesidad concreta; el puerto admite añadirlas sin cambiar el contrato.
