# ADR 0022: expediente operacional del territorio

- Estado: aceptada
- Fecha: 2026-10-19
- ODD: `odd/tasks/territorial-operations.md`
- Amplía ADR 0011 (ontología y vínculos) y ADR 0017 (motor cartográfico); conserva ADR 0012.
- Numeración: 0020 es de MASCLI 4.0 (PR #63), 0021 y 0023 de otros PR abiertos (#65, #67).

## Contexto

La fase 3 de la hoja de ruta territorial pide relacionar señales, alertas, compromisos y acciones
de un territorio para responder qué ocurrió en una concesión, qué señales justifican una alerta,
qué se hizo y con qué resultado. Los registros ya se enlazan con vínculos tipados explícitos o
inferidos de campos de referencia (`Alerta_Asociada`, `Demanda_Asociada`, actor principal), pero
`GET /system/graph` parte de un solo registro y recorre todos los tipos de vínculo, de modo que
un actor con muchos registros arrastra hechos de otros lugares.

## Decisión

- `POST /system/graph/neighbourhood` recibe hasta 100 registros semilla, uno o dos saltos con los
  tipos de vínculo que sigue cada salto y hasta 24 campos adicionales del payload. Devuelve los
  nodos visibles (máximo 400), los vínculos entre ellos y `truncated`. Calcula y no persiste nada,
  por lo que el rol de consulta también puede usarlo; los registros restringidos siguen ocultos
  para ese rol como en el resto de la ontología.
- El mapa territorial pide, desde las señales (eventos, narrativas, demandas) y los actores de lo
  seleccionado, el salto 1 `origina`, `responde_a`, `participa_en`, `plantea`, `difunde`,
  `sustenta` y el salto 2 `atiende`. Así llega a las acciones que atienden las alertas sin
  recorrer los demás registros de un actor.
- El expediente (`features/geography/operations.ts`) es una función pura del cliente: alertas con
  las señales que las originan y su estado de información, acciones con estado, plazo y resultado,
  compromisos con avance y demandas a las que responden, actores agrupados por tipo y una lista de
  pendientes deterministas: alerta abierta sin acción, alerta sustentada solo en información
  estimada o hipotética, acción o compromiso con fecha límite explícita vencida, acción cumplida
  sin resultado y demanda abierta sin respuesta vinculada.
- El ámbito sigue la selección: los registros vinculados a una concesión por geometría o código,
  un registro, o los 100 registros visibles más recientes del mapa con sus filtros y periodo.
- Las acciones ganan el campo opcional `Resultado`; los registros anteriores siguen válidos.

## Consecuencias

Ningún nombre, localidad o texto relaciona registros: un vínculo ausente se ve como pendiente y se
corrige vinculando, no adivinando. Los plazos en texto libre no se interpretan. No hay
predicción ni propagación. Proximidad y áreas de influencia siguen para la fase PostGIS.
