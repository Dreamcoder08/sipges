# Vista general del Centro de alertas

## Especificación

- S1 (2026-10-18): el titular pidió «una especie de clasificación o mapa de calor» en el Centro de alertas, con una referencia visual de KPIs, mapa de calor por dimensión SIPGES y comunidad, evolución mensual, comunidades prioritarias y alertas recientes.
- S2: la pestaña «Vista general» abre el Centro de alertas; «Alertas territoriales» y «Acciones territoriales» conservan la tabla, fichas, importación y edición. La tabla de alertas muestra la columna «Comunidad / territorio».
- S3: todo se calcula con las alertas almacenadas del proyecto activo. Se mantienen las reglas de `alert-heatmap-actor-map.md`: el territorio sale del campo de la alerta o de una referencia exacta a su evento; no se deduce de la causa. Sin registros es «Sin datos». Los colores registrados se nombran Bajo (verde), Atención (amarillo), Medio-alto (naranja) y Crítico (rojo).
- S4: periodo de 6 meses, 12 meses o todo; termina en el mes actual. Las alertas sin fecha solo cuentan en «Todo» y se indican bajo el gráfico. Las comunidades se ordenan por nivel máximo activo y luego por número de alertas activas.

## Implementación

Modelo puro `features/records/insights/alert-overview.ts`, componente `AlertOverview.tsx` y gráfico `StackedColumnChart` sin dependencias nuevas. El mapa de calor existente pasa de la lista a la vista general, con colores de mayor contraste y fila de dimensión fija al desplazar en móvil. «Ver» y las celdas abren la vista 360° de la alerta.

## Verificación

Pruebas de modelo (periodos, comparación con el periodo anterior, ranking, fechas dd/mm/aaaa, alertas sin fecha) y de interfaz (pestaña inicial, celdas, ranking, recientes, columna de territorio). Playwright 15-record-insights en escritorio y 390 px con axe WCAG AA sin infracciones y sin desbordamiento horizontal; capturas revisadas con datos sintéticos. Sin operaciones sobre datos de producción.
