# SIPGES RC 2.6 — integración territorial de señales digitales

- Continuación íntegra de RC 2.5.
- Nueva bandeja SQLite `digital_alert_reviews` por proyecto con fecha, URL, extracto, SHA-256 del texto, temas, señales, prioridad y método de análisis.
- Evaluación en modo reglas, automático u Ollama local opcional.
- Flujo de revisión humana: pendiente, corroborado, descartado, en seguimiento; notas y auditoría de cambios.
- Resumen por proyecto: estados, prioridades y temas predominantes.
- El motor IRSA **NO** cambia ni recibe ponderaciones arbitrarias de alertas digitales.
- No monitoriza enlaces/redes de forma autónoma; el texto y las interacciones se proporcionan manualmente.
- **Seguridad:** El servidor previo carece de autenticación y autorización reales. La revisión no supone verificación de identidad del revisor; no publicar en internet ni cargar datos sensibles sin implementar controles.
- No existe prueba científica de capacidad predictiva ni una evaluación de conflictos de personas o comunidades.
- El endpoint guarda un extracto (hasta 500 caracteres), no la publicación completa; validar protección de datos para un uso real.

## Endpoints
POST /system/intelligence/territorial-alerts
GET /system/intelligence/territorial-alerts?project_id=...
PATCH /system/intelligence/territorial-alerts/{review_id}
GET /system/intelligence/territorial-summary?project_id=...
