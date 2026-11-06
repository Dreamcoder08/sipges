SIPGES – PROYECTO SECHURA
PREPARACIÓN PARA RENDER — NO LISTO PARA PRODUCCIÓN

No publique datos reales ni suba todos los archivos indiscriminadamente.
Mantenga el repositorio privado; excluya semillas operativas, registros personales y credenciales. No hay URL desplegada ni persistencia verificada por esta preparación.

COOKIES Y HTTPS:
- En el servicio HTTPS deje SIPGES_COOKIE_SECURE sin definir o configure exactamente 1.
- Las cookies de sesión y selección de proyecto son Secure por defecto.
- Solo el valor exacto 0 desactiva Secure: reservado para pruebas HTTP locales en loopback, nunca para el servicio público.
- Vacío, espacios y cualquier otro valor provocan error al importar, antes de inicializar recursos.
- La política se fija al inicio; reinicie después de cambiarla. No configura TLS por sí misma.
- No utilice los lanzadores locales .bat/.sh (reference/python/) como comando de despliegue: asignan 0 cuando la variable está ausente para su listener 127.0.0.1.
- Detalles y límites de variables vacías en shells: docs/secure-cookies.md.

CONFIGURACIÓN DE DESPLIEGUE A VALIDAR (NO EJECUTAR CON DATOS REALES):
El repositorio incluye configuración Render/FastAPI/Uvicorn y health check /health. Tras resolver los bloqueos, conecte únicamente el repositorio privado autorizado al proveedor, revise render.yaml y configure HTTPS y secretos fuera del código. Una respuesta /health no prueba seguridad ni durabilidad.

BLOQUEOS DE DATOS:
Render Free no proporciona disco persistente; SQLite local, bases de autenticación/proyectos, configuración mutable y archivos subidos pueden perderse al reiniciar, recrear o redesplegar. Una ruta /tmp/sipges.db no es persistencia durable. Recargar data/seed.json tampoco preserva los cambios. La adaptación a PostgreSQL/almacenamiento privado sigue pendiente: DATABASE_URL por sí sola no migra esta aplicación. No se autoriza migración real en esta unidad.

BLOQUEOS DE SEGURIDAD Y VALIDACIÓN:
Siguen pendientes política/recuperación MFA, límites de intentos de login, endurecimiento CSRF/host/solicitudes, permisos privados de almacenamiento y pruebas de autorización, aislamiento y persistencia tras reinicio en HTTPS real. Cookies Secure no resuelven estos bloqueos. Cuentas de proveedor y despliegue siguen sin verificar.

ESTADO ACADÉMICO:
La validación externa del modelo sigue pendiente. Consulte odd/tasks/python-free-hosting-preparation.md para el plan de preparación; este documento no constituye aprobación de exposición pública.
