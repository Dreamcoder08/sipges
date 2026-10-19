# MASCLI 4.0: situaciones relacionadas, alertas explicadas y buzón

## Especificación

- S1 (2026-10-19): el cliente pidió que MASCLI pase «de ser solo un lugar donde guardamos información a un sistema que también relacione los hechos, detecte si una situación está creciendo, genere alertas y sugiera qué acción preventiva se podría tomar». El titular autorizó avanzar de forma autónoma.
- S2 (relación): reconocer como relacionados los registros que comparten tema, actor o territorio en fechas cercanas. El territorio sale solo de campos registrados (Territorio, Comunidad, Localidad, Distrito); nunca se deduce del texto.
- S3 (tiempo): un hecho antiguo pesa menos que uno reciente. Si en pocos días se repiten quejas, publicaciones o reuniones sobre un tema, el sistema indica que la situación está en aumento.
- S4 (explicación): cada alerta sugerida muestra qué registros la originaron y por qué, por ejemplo «Naranja porque existen tres registros recientes relacionados con empleo local y participación de determinados actores».
- S5 (recomendación): tras una alerta se muestran acciones orientativas (coordinar reunión, verificar información, seguir un compromiso, contactar a un actor). La decisión final es siempre de la persona.
- S6 (colores): cada color se muestra con su significado, por ejemplo «Naranja – Requiere intervención preventiva». Significados preliminares (pendientes de revisión con el Ing. Rogger), por eso configurables por proyecto: Verde, situación estable / riesgo bajo; Amarillo, requiere atención y seguimiento; Naranja, requiere intervención preventiva; Rojo, situación crítica / atención inmediata.
- S7 (narrativas): preparar redes y medios para que más adelante la IA revise publicaciones, identifique temas repetidos y detecte cambios de narrativa. Ahora se hace con reglas deterministas; la IA externa requiere aprobación del titular.
- S8 (buzón): registrar quejas, denuncias, consultas y sugerencias con estado, responsable y seguimiento dentro del sistema.
- S9 (trazabilidad): saber quién ingresó una información, quién la revisó, qué cambió y cuándo.
- S10 (versión): lo que funciona en MASCLI 3.0 se mantiene. Las mejoras forman MASCLI 4.0, activable por proyecto y desactivada por defecto.
- Reglas vigentes: solo datos reales (pruebas con datos sintéticos), sin credenciales, IRSA no se modifica automáticamente, sin despliegue ni migración de datos reales sin la palabra del titular.

## Diseño

ADR [0020](../../docs/adr/0020-mascli-4-situations.md). Nuevo contexto `situations` con dominio puro:
configuración del proyecto (interruptor, significados de colores, umbrales y catálogo de
recomendaciones) y motor de situaciones (señales normalizadas, agrupación por clave, peso
temporal, tendencia, explicación citada y recomendaciones). La creación de una alerta desde
una situación usa el módulo Alertas existente, con el historial y las reglas de siempre, y
siempre la confirma una persona. El buzón es un módulo de registros más (`buzon`), visible con
4.0 activo. La trazabilidad reutiliza el historial inmutable de versiones (ADR 0011).

## Plan de implementación y pruebas

- T1 [ ] — Interruptor MASCLI 4.0 por proyecto y colores con significado configurable; pruebas de dominio, HTTP, permisos y UI. commit: pending
- T2 [ ] — Motor de situaciones: relación por tema, actor y territorio explícito, peso temporal y tendencia; pruebas puras y HTTP. commit: pending
- T3 [ ] — Explicación citada y recomendaciones orientativas configurables; pruebas de dominio. commit: pending
- T4 [ ] — Pantalla «Situaciones» y alerta explicada creada por una persona; pruebas de UI. commit: pending
- T5 [ ] — Buzón de quejas, denuncias, consultas y sugerencias con seguimiento; pruebas de módulo y UI. commit: pending
- T6 [ ] — Trazabilidad visible: registrado por, revisado por, cambios y fechas; pruebas de UI. commit: pending
- T7 [ ] — Narrativas preparadas para IA: temas repetidos y cambio de tono, con puerto para un asistente futuro; pruebas puras. commit: pending
- T8 [ ] — Verificación integrada, revisión, PRs y activación (la activación en producción requiere la palabra del titular). commit: pending

## Registro

- L1 (Diagnóstico): base main `046bb1a`. El IRSA usa el estado vigente de los registros, sin ventana temporal; el analizador de textos sugiere pasos de verificación; las alertas territoriales y los registros de Alertas no muestran qué registros las originaron; no existe buzón; el historial de versiones guarda actor, fecha y cambios. No se leyeron data/seed.json ni bases locales.
