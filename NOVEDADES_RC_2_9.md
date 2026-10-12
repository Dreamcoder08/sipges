# MASCLI RC 2.9 — Acceso y roles efectivos

Versión incremental basada en RC 2.8. Conserva panel gerencial, MASCLI IRSA, directorio, redes y medidas preventivas.

## Primer inicio (Windows PowerShell)
Desde la carpeta extraída, antes de iniciar:

```powershell
$env:MASCLI_ADMIN_USERNAME="crystell"
$env:MASCLI_ADMIN_PASSWORD="COLOQUE_AQUI_UNA_CLAVE_UNICA_DE_AL_MENOS_12_CARACTERES"
python -m uvicorn app:app --host 127.0.0.1 --port 8000
```
Abra http://127.0.0.1:8000; luego inicie sesión con el usuario y clave configurados.
La contraseña inicial SOLO se usa para crear la primera cuenta. Si ya existen cuentas, cambiar esa variable NO cambia la contraseña de la base de datos.
Nunca publique contraseñas en el repositorio o archivos compartidos.

Roles efectivos en los endpoints (no confundir con los registros históricos de "Usuarios"):
- admin: administración de cuentas, catálogos, operaciones y exportación.
- analista: lecturas y escritura ordinaria; no administra cuentas ni proyectos.
- coordinador: lectura y seguimiento preventivo / revisión de alertas, sin edición general.
- consulta: lectura solamente.

Crear una cuenta autenticada siendo administrador:
```powershell
# En navegador: /docs -> POST /system/auth/accounts, autenticado previamente en la misma sesión.
```
Ejemplo JSON: {"username":"analista01","full_name":"Analista territorial","password":"EJEMPLO_CAMBIAR_ESTA_CLAVE_1234","role":"analista"}
La lista auténtica está en GET /system/auth/accounts. Las fichas legadas en el menú Usuarios no son cuentas con clave y no conceden acceso.

## Seguridad y limitaciones
- Sesiones aleatorias almacenadas como hash SHA-256; cookies HttpOnly / SameSite Strict; PBKDF2 para contraseñas.
- Para HTTPS configurar MASCLI_COOKIE_SECURE=1. En desarrollo localhost HTTP mantener 0.
- Control de acceso del lado servidor para rutas web y API; restricciones de escritura por rol.
- NO implementa aislamiento de datos multiempresa ni permisos granulares por proyecto.
- NO incluye MFA, restablecimiento de contraseña, protección avanzada contra fuerza bruta ni auditoría de ciberseguridad.
- NO se recomienda exponer esta versión directamente a Internet ni cargar datos personales reales hasta concluir controles, pruebas y un despliegue seguro.
- La comprobación de origen mitiga algunas solicitudes cruzadas; los endpoints deben seguir evaluándose frente a CSRF en despliegues reales.
- El motor de IRSA sigue independiente de las alertas digitales.
- El ZIP no incorpora mascli.db: se crea desde seed.json al iniciar. Si tiene una base anterior, haga copia de seguridad y coloque su archivo mascli.db en data/ antes del arranque; la tabla de autenticación se añadirá automáticamente.
