# ADR 0016: ejecución verificable de inteligencia territorial

- Estado: aceptada
- Fecha: 2026-10-17
- ODD: `odd/tasks/territorial-intelligence-alerts.md`
- Amplía ADR 0014; conserva ADR 0002, 0003, 0011 y 0012.

## Contexto

Hosting no inicia el intervalo del servidor persistente. Los eventos digitales no pertenecen
a module_records, y una URL de referencia no es un conector de datos. Hobby solo permite cron
diario; no se presupone ejecución frecuente gratuita.

## Decisión

Persistir instantáneas de auditoría en la transacción de cada señal/revisión. Las reglas consumen
el evento original, no una revisión posterior mutable. Evaluar Narrativas es opcional y explícito,
excluye restringidos y crea señales pendientes, sin predicciones ni cambios de IRSA. Deduplicar
24 horas por proyecto y evidencia mediante bloqueo de fila, con RLS y conservando históricos.

Despertar el motor después de mutaciones correctas. Vercel conserva su ejecución con waitUntil;
el servidor persistente y cron usan el mismo coordinador. El trabajador aplica contexto propio
para leer la clasificación real y filtrar destinatarios. Registrar cada intento por proyecto
con token evita que una finalización antigua sobrescriba otra nueva. Una escritura concurrente
solicita otro barrido. Límites de tiempo/cantidad y cursores conservan trabajo pendiente.

Las fuentes fallidas no bloquean entregas anteriores, aunque el intento quede fallido y cron
responda con error. Entregas push por dispositivo conservan reintentos y comprueban permisos
vigentes. La aceptación no demuestra recepción; una respuesta perdida puede repetir una entrega
externa. La bandeja mantiene una notificación por ejecución de regla.

Adaptadores acotados consultan INGEMMET y metadatos públicos de Defensoría. Nunca descargan URLs
arbitrarias de entrada. Los conectores requieren autorización explícita y están desactivados
inicialmente; las relaciones territoriales requieren geometría o referencia documentada.

## Consecuencias

No se añade IA ni un ejecutor de pago. El teléfono requiere suscripción y permisos. El cron
diario es respaldo, sin garantía de detección inmediata de publicaciones externas. Disponibilidad
oficial y recepción real se prueban por separado de adaptadores controlados. Las migraciones
son aditivas y la reversión conserva datos, cursores y entregas pendientes.

Operación: [inteligencia territorial y avisos](../deployment/territorial-intelligence.md).
