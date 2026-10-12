MASCLI RC 3.0 — Inicio local Windows (prueba técnica)

1. Extraiga ZIP y abra PowerShell dentro de MASCLI_RC_3_0.
2. Instale dependencias: pip install -r requirements.txt
3. Configure:
   $env:MASCLI_ADMIN_USERNAME="crystell"
   $env:MASCLI_ADMIN_PASSWORD="CAMBIAR-POR-UNA-CLAVE-MUY-SEGURA"
4. Inicie: python -m uvicorn app:app --host 127.0.0.1 --port 8000
5. Abra http://127.0.0.1:8000
6. Para múltiples proyectos, cree scopes con API autenticada y seleccione desde /select-project.
7. Para MFA, consulte NOVEDADES_RC_3_0.md (TOTP setup/enable).

IMPORTANTE: Conserve respaldos separados del directorio data/ antes de migrar desde RC 2.9. No publique a Internet ni utilice datos personales reales durante el piloto sin evaluación de seguridad.
