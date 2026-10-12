# MASCLI RC 2.8 — Centro de control gerencial

Evolución directa de RC 2.7. Nuevo menú **Centro gerencial** con KPIs por proyecto, distribución de alertas, acciones por estado, pendientes de verificación, acciones vencidas, responsables y tabla de alertas recientes. Descarga CSV desde el tablero.

## Rutas
- `GET /system/management/overview?project_id=PRJ-SECHURA`
- `GET /system/management/report.csv?project_id=PRJ-SECHURA`

Los cálculos no alteran IRSA. El conteo de compromisos vencidos usa estados explícitos; los campos de fecha de compromisos no están homologados. No hay autenticación empresarial. No usar con datos confidenciales ni desplegar públicamente sin refuerzo de seguridad.
