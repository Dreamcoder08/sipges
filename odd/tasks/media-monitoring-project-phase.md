# Monitoreo de medios y fase del proyecto

## Especificación

- S1 (2026-10-19): el cliente preguntó si MASCLI vigila por sí solo medios y redes, y si distingue la fase del proyecto (un proyecto puede ser una mina en operación). Ambas cosas faltaban; el titular autorizó avanzar de forma autónoma.
- S2 (monitoreo): un administrador registra fuentes RSS o Atom regionales (medios, radios, blogs, páginas institucionales) con palabras clave y territorio opcionales. Una tarea programada las consulta y crea una narrativa por cada noticia nueva que coincide, con enlace, fecha, fuente y huella; la misma noticia nunca se crea dos veces.
- S3 (alertas): las narrativas importadas pasan por las reglas de siempre (incluida la regla «evaluar» de Narrativas), así que una noticia relevante puede generar una alerta sin pasos nuevos.
- S4 (fase): el proyecto tiene una fase (Exploración, Construcción, Operación o Cierre). Cada fase puede tener sus propios pesos IRSA por dimensión, que suman 1. Las sugerencias por fase son preliminares, pendientes de validación metodológica (AHP/Delphi), y solo se aplican si un administrador las guarda.
- S5 (3.0 intacto): todo vive en MASCLI 4.0. Con el interruptor apagado no se consulta ninguna fuente y el IRSA usa los pesos generales de siempre.
- Reglas vigentes: sin servicios pagos ni credenciales conectadas sin el titular; solo URLs https públicas; datos sintéticos en pruebas; sin despliegue ni activación en producción sin la palabra del titular.

## Diseño

ADR [0021](../../docs/adr/0021-media-monitoring-and-project-phase.md). El monitoreo es un servicio
del contexto `integration` junto al conector de la Defensoría y reutiliza su importador de
narrativas idempotente y el arranque de la tarea programada. La fase y sus pesos son parte de
la configuración de MASCLI 4.0 (`project_settings`); el IRSA los recibe por un puerto.

## Plan de implementación y pruebas

- T1 [ ] — Fase del proyecto y pesos IRSA por fase en la configuración 4.0; pruebas de dominio, HTTP e IRSA. commit: pending
- T2 [ ] — Lector RSS/Atom puro, filtro por palabras clave y validación de URL pública; pruebas puras. commit: pending
- T3 [ ] — Fuentes de monitoreo por proyecto, consulta programada e importación idempotente a Narrativas; pruebas HTTP y de cron. commit: pending
- T4 [ ] — Pantallas: fase y pesos, fuentes de monitoreo con vista previa y estado; pruebas de UI. commit: pending
- T5 [ ] — Verificación integrada y PR en borrador (la activación en producción requiere la palabra del titular). commit: pending

## Registro

- L1 (Diagnóstico): base PR #63 `30f1da9`. Ya existe una consulta programada de la Defensoría (`beforeTick` en cron) que importa narrativas con id canónico y huella; las reglas «evaluar» de Narrativas convierten narrativas en alertas. No hay lector RSS ni fase; el IRSA usa un único juego de pesos por proyecto. No se leyeron data/seed.json ni bases locales.
