# Monitoreo de medios y fase del proyecto

## Especificación

- S1 (2026-10-19): el cliente preguntó si MASCLI vigila por sí solo medios y redes, y si distingue la fase del proyecto (un proyecto puede ser una mina en operación). Ambas cosas faltaban; el titular autorizó avanzar de forma autónoma.
- S2 (monitoreo): un administrador registra fuentes RSS o Atom regionales (medios, radios, blogs, páginas institucionales) con palabras clave y territorio opcionales. Una tarea programada las consulta y crea una narrativa por cada noticia nueva que coincide, con enlace, fecha, fuente y huella; la misma noticia nunca se crea dos veces.
- S3 (alertas): las narrativas importadas pasan por las reglas de siempre (incluida la regla «evaluar» de Narrativas), así que una noticia relevante puede generar una alerta sin pasos nuevos.
- S4 (fase): el proyecto tiene una fase (Exploración, Construcción, Operación o Cierre). Cada fase puede tener sus propios pesos IRSA por dimensión, que suman 1. Las sugerencias por fase son preliminares, pendientes de validación metodológica (AHP/Delphi), y solo se aplican si un administrador las guarda.
- S5 (reemplazada 2026-10-26 por [mascli-4-only](mascli-4-only.md)): todo vive en MASCLI 4.0 y ya no hay interruptor; se consultan solo las fuentes configuradas y no pausadas, y el IRSA usa los pesos de la fase guardada. Texto anterior: «todo vive en MASCLI 4.0. Con el interruptor apagado no se consulta ninguna fuente y el IRSA usa los pesos generales de siempre».
- Reglas vigentes: sin servicios pagos ni credenciales conectadas sin el titular; solo URLs https públicas; datos sintéticos en pruebas; sin despliegue ni activación en producción sin la palabra del titular.

## Diseño

ADR [0021](../../docs/adr/0021-media-monitoring-and-project-phase.md). El monitoreo es un servicio
del contexto `integration` junto al conector de la Defensoría y reutiliza su importador de
narrativas idempotente y el arranque de la tarea programada. La fase y sus pesos son parte de
la configuración de MASCLI 4.0 (`project_settings`); el IRSA los recibe por un puerto.

## Plan de implementación y pruebas

- T1 [x] — Fase del proyecto y pesos IRSA por fase en la configuración 4.0; pruebas de dominio, HTTP e IRSA. commit: see L2
- T2 [x] — Lector RSS/Atom puro, filtro por palabras clave y validación de URL pública; pruebas puras. commit: see L3
- T3 [x] — Fuentes de monitoreo por proyecto, consulta programada e importación idempotente a Narrativas; pruebas HTTP y de cron. commit: see L4
- T4 [x] — Pantallas: fase y pesos, fuentes de monitoreo con vista previa y estado; pruebas de UI. commit: see L5
- T5 [ ] — Verificación integrada y PR en borrador (la activación en producción requiere la palabra del titular). commit: pending

## Registro

- L1 (Diagnóstico): base PR #63 `30f1da9`. Ya existe una consulta programada de la Defensoría (`beforeTick` en cron) que importa narrativas con id canónico y huella; las reglas «evaluar» de Narrativas convierten narrativas en alertas. No hay lector RSS ni fase; el IRSA usa un único juego de pesos por proyecto. No se leyeron data/seed.json ni bases locales.
- L2 (T1 Fase y pesos): project_settings guarda phase (exploracion, construccion, operacion, cierre o null) y phaseWeights por fase, que suman 1 ± 0,02 y se fusionan por fase (null vuelve a los pesos generales). GET /system/v4/settings devuelve cada fase con su sugerencia preliminar; el cambio se audita como 'Fase …'. El IRSA recibe los pesos por un puerto solo con 4.0 activo y pesos guardados para la fase actual, y lo indica en phase y en sus notas; en otro caso el resultado es idéntico al anterior (prueba de igualdad). Commit ff4ffd6.
- L3 (T2 Lector RSS): domain/feeds.ts lee RSS 2.0, RSS 1.0 y Atom sin expandir entidades externas: clave (guid/id/enlace), título, enlace http(s), resumen en texto plano y fecha ISO; descarta ítems sin título o enlace válido. Palabras clave enteras sin mayúsculas ni tildes. feedUrlProblem acepta solo https a nombres públicos sin puerto ni credenciales; isPrivateAddress cubre IPv4/IPv6 privadas y reservadas. Commit d3e3775.
- L4 (T3 Monitoreo programado): Migración 0026 media_feeds con RLS (máx. 20 por proyecto, URL única). /system/v4/media: listar, agregar, editar o pausar, eliminar (auditados, solo admin), vista previa sin guardar y consulta manual. El cron de automatizaciones consulta las fuentes vencidas (30 min) en paralelo con la Defensoría, solo con 4.0 activo; cada noticia coincidente crea una vez la narrativa SRC-RSS-<hash de URL y clave> con Fecha_Observacion, Tema y Palabras_Clave, y las reglas de Narrativas la ven (prueba con notificación). El lector resuelve DNS y rechaza direcciones privadas, no sigue redirecciones y corta a 8 s y 1 MB. Commit 5e6a6ed.
- L5 (T4 Pantallas): Con 4.0 activo, la página MASCLI 4.0 muestra la tarjeta Fase del proyecto (botones de fase, pesos por dimensión con suma, sugerencia preliminar y vuelta a pesos generales) y Fuentes RSS regionales (estado de la última consulta, pausar/eliminar, Consultar ahora, Probar fuente y alta con nota de autorización). Con 4.0 apagado no aparecen; otros roles las ven solo en lectura. Commit e88bf04.
- L6 (2026-10-26, cambio de requisito): «quiero que todo este en 4.0 , objetivo actualizar todo , eliminar redundancia objetivo estar en la vanguardia». S5 reescrita; ver mascli-4-only y ADR 0027.
