# SIPGES: situaciones relacionadas, alertas explicadas y buzón

## Especificación

- S1 (2026-10-19): el cliente pidió que SIPGES pase «de ser solo un lugar donde guardamos información a un sistema que también relacione los hechos, detecte si una situación está creciendo, genere alertas y sugiera qué acción preventiva se podría tomar». El titular autorizó avanzar de forma autónoma.
- S2 (relación): reconocer como relacionados los registros que comparten tema, actor o territorio en fechas cercanas. El territorio sale solo de campos registrados (Territorio, Comunidad, Localidad, Distrito); nunca se deduce del texto.
- S3 (tiempo): un hecho antiguo pesa menos que uno reciente. Si en pocos días se repiten quejas, publicaciones o reuniones sobre un tema, el sistema indica que la situación está en aumento.
- S4 (explicación): cada alerta sugerida muestra qué registros la originaron y por qué, por ejemplo «Naranja porque existen tres registros recientes relacionados con empleo local y participación de determinados actores».
- S5 (recomendación): tras una alerta se muestran acciones orientativas (coordinar reunión, verificar información, seguir un compromiso, contactar a un actor). La decisión final es siempre de la persona.
- S6 (colores): cada color se muestra con su significado, por ejemplo «Naranja – Requiere intervención preventiva». Significados preliminares (pendientes de revisión con el Ing. Rogger), por eso configurables por proyecto: Verde, situación estable / riesgo bajo; Amarillo, requiere atención y seguimiento; Naranja, requiere intervención preventiva; Rojo, situación crítica / atención inmediata.
- S7 (narrativas): preparar redes y medios para que más adelante la IA revise publicaciones, identifique temas repetidos y detecte cambios de narrativa. Ahora se hace con reglas deterministas; la IA externa requiere aprobación del titular.
- S8 (buzón): registrar quejas, denuncias, consultas y sugerencias con estado, responsable y seguimiento dentro del sistema.
- S9 (trazabilidad): saber quién ingresó una información, quién la revisó, qué cambió y cuándo.
- S10 (versión, reemplazada 2026-10-26 por [mascli-4-only](mascli-4-only.md)): todo funciona como SIPGES; el interruptor por proyecto se retira. Texto anterior: «lo que funciona en MASCLI 3.0 se mantiene. Las mejoras forman MASCLI 4.0, activable por proyecto y desactivada por defecto».
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

- T1 [x] — Interruptor SIPGES por proyecto y colores con significado configurable; pruebas de dominio, HTTP, permisos y UI. commit: see L2
- T2 [x] — Motor de situaciones: relación por tema, actor y territorio explícito, peso temporal y tendencia; pruebas puras y HTTP. commit: see L3
- T3 [x] — Explicación citada y recomendaciones orientativas configurables; pruebas de dominio. commit: see L4
- T4 [x] — Pantalla «Situaciones» y alerta explicada creada por una persona; pruebas de UI. commit: see L5
- T5 [x] — Buzón de quejas, denuncias, consultas y sugerencias con seguimiento; pruebas de módulo y UI. commit: see L6
- T6 [x] — Trazabilidad visible: registrado por, revisado por, cambios y fechas; pruebas de UI. commit: see L7
- T7 [x] — Narrativas preparadas para IA: temas repetidos y cambio de tono, con puerto para un asistente futuro; pruebas puras. commit: see L8
- T8 [x] — Verificación integrada, revisión y PRs; sin interruptor no hay paso de activación aparte (ver mascli-4-only). El despliegue a producción requiere la palabra del titular. commit: pending

## Registro

- L1 (Diagnóstico): base main `046bb1a`. El IRSA usa el estado vigente de los registros, sin ventana temporal; el analizador de textos sugiere pasos de verificación; las alertas territoriales y los registros de Alertas no muestran qué registros las originaron; no existe buzón; el historial de versiones guarda actor, fecha y cambios. No se leyeron data/seed.json ni bases locales.
- L2 (T1 Interruptor y colores): Tabla project_settings con RLS, GET/PUT /system/v4/settings (escritura solo admin, auditada como CONFIG_UPDATE). Con el interruptor apagado la web muestra el menú y las pantallas de 3.0; encendido, cada color va con su significado (por defecto los preliminares del cliente). Commits 1e9e764, 67f2fca.
- L3 (T2 Motor de situaciones): Señales de Eventos, Demandas, Compromisos, Narrativas, Alertas, Diálogos y Buzón con fecha; agrupación por tema (palabras clave), actor y territorio solo de campos registrados; peso 0,5^(edad/vida media) por severidad; tendencia en aumento sube un nivel; umbrales 2/4/7 configurables. Commit 1e9e764.
- L4 (T3 Explicación y recomendaciones): Cada situación cita sus registros y razones; catálogo de 8 condiciones con textos editables por proyecto; la alerta solo se crea si una persona pulsa el botón. Commit 1e9e764.
- L5 (T4 Pantalla Situaciones): Ruta /situaciones con tarjetas (color con significado, por qué, acciones sugeridas, registros) y botón para crear la alerta explicada; el detalle de la alerta muestra su explicación. Commit 67f2fca.
- L6 (T5 Buzón): Módulo Buzon (prefijo BZ) con tipo, canal, responsable, plazo y estados Recibido → Cerrado; entra como señal de situaciones. Commit 8ffe2c6.
- L7 (T6 Trazabilidad): Resumen sobre el historial existente: registrado por, revisado por (cambios de estado o verificación) y última modificación, con fecha. Commit 51572a2.
- L8 (T7 Narrativas para IA): Resumen de narrativas: temas repetidos, plataformas y cambio de tono (≥25 puntos). El puerto para un asistente de IA queda pendiente hasta que el titular apruebe proveedor y datos. Commit 1e9e764.
- L9 (2026-10-26, cambio de requisito): el titular pidió «quiero que todo este en 4.0 , objetivo actualizar todo , eliminar redundancia objetivo estar en la vanguardia». S10 y T8 se reescriben; la implementación vive en [mascli-4-only](mascli-4-only.md) y ADR 0027.
- L10 (2026-10-27, T8 Verificación integrada): E2E Chromium 93 aprobados / 1 omitido (incluye `19-sipges` y los flujos de medios), API 694 / 14 omitidos, web 282, revisión nativa aprobada (`review-b082ae718ab3f9a5`) y PR en borrador #81 (apilado sobre #80 y #79); evidencia en `odd/evidence/mascli-4-only/README.md`. La CI remota no arrancó por un bloqueo de facturación de la cuenta de GitHub. El despliegue a producción sigue requiriendo la palabra del titular y no se realizó.
