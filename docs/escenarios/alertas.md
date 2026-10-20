# Escenarios del clasificador de alertas

Cada fila es un texto sintético y la prioridad que el equipo social espera. Si cambias una regla
del clasificador (`apps/api/src/contexts/intelligence/domain/text-analysis.ts`), primero añade o
corrige aquí la fila que describe el caso; `pnpm verify` ejecuta esta tabla y falla si el
clasificador no da la prioridad esperada. Solo datos inventados: nunca textos reales.

Columnas: **Texto** (el mensaje), **Prioridad** (`Alta`, `Media` o `Baja`) y **Señales** (las
señales que deben aparecer, separadas por coma; vacío si ninguna).

| Texto | Prioridad | Señales |
| --- | --- | --- |
| Exigimos agua limpia: anuncian paro y bloqueo de vía este lunes; convocatoria a asamblea. Se rumorea que habrá enfrentamientos en las tierras comunales y piden empleo local. | Alta | Movilización anunciada, Demanda o reclamo, Convocatoria a reunión, Información no corroborada |
| Exigimos el cumplimiento del compromiso de empleo local y convocamos a asamblea comunal. | Media | Demanda o reclamo, Convocatoria a reunión |
| La comunidad celebró su aniversario con actividades culturales. | Baja | |
