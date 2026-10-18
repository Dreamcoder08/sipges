# Inteligencia territorial, GEOCATMIN y avisos verificables

## Especificación

- S1 (2026-10-17): ampliar GEOCATMIN y conectar narrativas/reportes con evaluación, revisión humana, reglas y notificaciones. Conservar TypeScript, arquitectura por contextos, roles, RLS, identidad visual y datos existentes. No contratar servicios ni crear registros para aparentar cobertura.
- S2: siete servicios oficiales con catálogo dinámico de subcapas, escalas, atribución y fecha de comprobación; selector, opacidad, WGS84 y errores visibles. Consultas acotadas a destinos oficiales, con límites de tamaño, tiempo y área. Sin inventar identificadores de capas.
- S3: relaciones con concesiones por geometría válida o código con fuente documentada. Distinguir esas relaciones y los registros sin ubicación; no geocodificar nombres ni inventar coordenadas.
- S4: señales con evidencia, territorio explícito, procedencia y estado pendiente; no son predicciones ni cambian IRSA. Deduplicación de evidencia durante 24 horas bajo concurrencia y RLS. Instantáneas inmutables de auditoría al crear/revisar; conservar históricos.
- S5: acción opcional de reglas para evaluar Narrativas, umbral mínimo Media. Excluir restringidos; preservar Tipo_Fuente válido. Evaluación y notificación en rondas acotadas, sin ciclos; trazabilidad al registro original.
- S6: bandeja interna única y entrega externa diferenciadas. Push requiere suscripción voluntaria y configuración; diagnóstico, prueba solo propia, reintentos por dispositivo, permisos vigentes y orientación iOS. Aceptación del proveedor no equivale a recepción/lectura.
- S7: procesamiento tras mutaciones correctas con ciclo de vida waitUntil en Vercel y cron diario autenticado compatible con Hobby. Estado observable por proyecto, límites y errores. No instalar un cron frecuente en el repositorio privado ni contratar ejecutores. Un ejecutor externo autorizado puede reutilizar el endpoint.
- S8: fuentes públicas autorizadas con opt-in explícito, procedencia, límites, idempotencia y errores visibles. Conector de metadatos de Defensoría, desactivado inicialmente. URLs de referencia no se descargan arbitrariamente; no scraping de redes privadas.
- S9: probar entrada → narrativa → evaluación → señal pendiente → reglas → bandeja/proveedor, con permisos, aislamiento, concurrencia y fallos. Identificar adaptadores de prueba. Recepción en teléfono real pendiente hasta tener suscripción y confirmación del dispositivo.

## Diseño

Reutilizar analizador por reglas, automatizaciones, bandeja y Web Push. El mapa SVG conserva
geometrías y añade adaptadores de INGEMMET. Contratos Zod, casos de uso por contexto y puertos
inyectables permiten comprobar fuentes reales por separado de las pruebas controladas.

`intelligence.evaluateNarrative(scope,{id,payload,marking,minimumLevel})` devuelve created,
duplicate o ineligible. Los eventos digitales consumen `audit.event_payload`, evitando unirlos
a module_records o a una revisión posterior mutable. Los cursores y entregas conservan trabajo
pendiente; una nueva escritura concurrente solicita un barrido posterior. El trabajador usa
su propio contexto de seguridad para aplicar la clasificación real de los eventos.

Migraciones aditivas: 0021 procedencia/deduplicación/instantáneas; 0022 entregas push; 0023 estado
del motor; 0024 fuentes autorizadas. Revertir código conserva tablas, columnas y datos.
Defensoría no condiciona la entrega de avisos anteriores: una caída de la fuente se registra,
se intenta igualmente el motor y el ciclo responde con error sin aparentar éxito completo.

## Plan de implementación y pruebas

- T1 [ ] — Catálogo y selector GEOCATMIN con errores verificables; pruebas de URL, CRS, escalas, opacidad y disponibilidad. commit: pending
- T2 [ ] — Consultas y relaciones reales con concesiones; geometrías, límites, timeout y aislamiento. commit: pending
- T3 [x] — Señales, procedencia, deduplicación, revisión y auditoría; concurrencia, estados y exclusión de restringidos. commit: see L4
- T4 [x] — Reglas de evaluación y entrega; bandeja, reintentos, permisos y diagnóstico de dispositivo. commit: see L5
- T5 [x] — Ejecución por eventos y respaldo diario autenticado, con estado observable y frecuencia documentada. commit: see L7
- T6 [x] — Fuentes autorizadas, conector explícito y hook estructurado; idempotencia, límites, permisos y errores. commit: see L6
- T7 [ ] — Verificación integrada, revisión independiente, PR, integración y despliegue. commit: pending
- T8 [ ] — Recepción real en teléfono y activación de canales/fuentes que requieren credenciales, suscripción o autorización del operador. commit: pending

## Registro

- L1 (Diagnóstico): base main `4f0782c`. El mapa usa catastro capa 0; los eventos digitales carecían de campos al unirse solo a module_records. Hosting no inicia el intervalo de main.ts; el endpoint GET/POST de cron ya existe. Repositorio privado, rama main. No se leyeron data/seed.json ni bases locales.
- L2 (Revisión): detectados y corregidos en la implementación el bloqueo de entregas por caída de fuente, la pérdida de un despertar concurrente y la herencia de acceso limitado al ejecutar desde cron/integraciones. Regresiones específicas acompañan las correcciones. La disponibilidad remota de GEOCATMIN y la recepción real de push no se deducen de pruebas controladas.
- L3 (Recuperación del entorno): el entorno se reinició antes de publicar la primera copia. GitHub conservó main sin cambios. Se restauró el código desde el trabajo de los agentes; se repiten las comprobaciones antes de publicar. Las verificaciones completas interrumpidas no cuentan como aprobadas. La configuración VAPID/CRON ya creada en Vercel se conserva sin rotar claves.
- L4 (T3 señales verificadas): PR #53, código ed35840. Procedencia, Tipo_Fuente, territorio explícito, deduplicación de 24 horas y auditoría CREATE/REVIEW inmutable implementados. Verificación específica restaurada: 32 pruebas puras/de dominio, 7 HTTP, 8 UI y 2 PostgreSQL reales aprobadas; concurrencia y aislamiento comprobados. La revisión humana y la independencia de IRSA se conservan. CI integral se registra en T7.
- L5 (T4 entrega verificable): PR #53. Acción evaluate, rondas acotadas, bandeja única, enlaces y reintentos push por dispositivo implementados. Pruebas específicas de reglas, entrega y UI aprobadas; regresiones de concurrencia, contexto de seguridad, reintentos y primer cursor sin replay verificadas. Chromium comprobó el recorrido automático sin tick manual en escritorio y teléfono. Recepción real en dispositivo continúa en T8; no se confunde con aceptación del proveedor.
- L6 (T6 ingreso autorizado): PR #53. Conector público de Defensoría con opt-in documentado, límites, revisión de configuración y procedencia; hook autenticado /hooks/signals idempotente implementado. Pruebas específicas: 11 API, 2 UI, 2 de SQL con propietario sin bypass RLS y 7 de exportación aprobadas. Regresión de entrada completa a señal/bandeja y de límites antes del parser comprobadas. Configuración por proyecto y snapshots se exportan sin incluir credenciales. Fuente oficial respondió HTTP 200 el 17 de octubre; activación de fuentes/canales sigue explícita en T8.
- L7 (T5 ejecución observable): PR #53, código ed35840. Motor tras mutaciones correctas con waitUntil, coalescencia y nuevo barrido concurrente; cron GET/POST autenticado, diario a las 04:15 UTC y estado de intentos por proyecto. Pruebas específicas: 9 de runtime puro y 7 HTTP con PostgreSQL; regresiones de ingreso estructurado, fallos de fuente que no bloquean avisos previos, contexto de seguridad y primer cursor verificadas. Chromium comprobó narrativa persistida → señal → bandeja sin tick manual. El respaldo diario de Hobby no promete latencia inmediata; recepción y activación real continúan en T8. CI integral y despliegue se registran en T7.
- L8 (Límites externos comprobados, 2026-10-18): GEOCATMIN catastro respondió HTTP 503; T1/T2 conservan pendientes de validación real aunque catálogo, consultas acotadas y relaciones están implementados y probados con adaptadores controlados. La vista previa b579714 alcanza READY en Vercel pero responde 503 al iniciar: los metadatos de configuración muestran que esta rama no tiene DATABASE_URL ni configuración de acceso asignadas. No se copiaron credenciales ni datos de producción a la vista previa. La validación integrada usa PostgreSQL aislado; el despliegue público requiere su comprobación posterior.
