SIPGES RC 3.0 — Inicio local Windows (prueba técnica)

1. Extraiga ZIP y abra PowerShell dentro de SIPGES_RC_3_0.
2. Instale dependencias: pip install -r requirements.txt
3. Configure:
   $env:SIPGES_ADMIN_USERNAME="crystell"
   $env:SIPGES_ADMIN_PASSWORD="CAMBIAR-POR-UNA-CLAVE-MUY-SEGURA"
   $env:SIPGES_COOKIE_SECURE="0"  # Solo para HTTP local en loopback
4. Inicie: python -m uvicorn app:app --host 127.0.0.1 --port 8000
5. Abra http://127.0.0.1:8000
6. Para múltiples proyectos, cree scopes con API autenticada y seleccione desde /select-project.
7. Para MFA, consulte reference/python/history/NOVEDADES_RC_3_0.md (TOTP setup/enable).

COOKIES: Sin SIPGES_COOKIE_SECURE, o con valor exacto 1, las cookies de sesión y proyecto requieren HTTPS. Solo el valor exacto 0 permite HTTP local. Vacío, espacios y otros valores producen error antes de inicializar recursos; reinicie tras cambiar la configuración.
Los cuatro lanzadores .bat/.sh de loopback (en reference/python/) asignan 0 solo si la variable está ausente; conservan 1 y valores inválidos. En cmd.exe, set "SIPGES_COOKIE_SECURE=" elimina la variable: no representa un vacío persistente. Los .bat usan Python setdefault para conservar un vacío heredado si llega al proceso; Bash conserva el vacío exportado y la app lo rechaza. Detalles: docs/secure-cookies.md.

IMPORTANTE: Conserve respaldos separados del directorio data/ antes de migrar desde RC 2.9. No publique a Internet ni utilice datos personales reales durante el piloto sin evaluación de seguridad. Esta corrección no implica preparación productiva: faltan persistencia durable, política/recuperación MFA, límites de intentos de login, endurecimiento CSRF/host/solicitudes y validación del despliegue HTTPS.
