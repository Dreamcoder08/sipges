# Seguridad de acceso y despliegue — MASCLI RC 3.0

Cambios de endurecimiento previos a cualquier despliegue (tarea ODD 2, primera entrega).
Todos tienen pruebas de regresión en `tests/test_security.py`.

## Comportamiento por defecto

| Control | Antes | Ahora |
|---|---|---|
| Exportación `/system/export` | Descargaba la base histórica global desde cualquier proyecto | Descarga solo la base del proyecto activo (`mascli_<empresa>_<proyecto>.db`) |
| MFA | Opcional; una sesión podía regenerar el secreto TOTP sin el código vigente | Obligatorio: tras el primer ingreso se redirige a `/mfa-setup`; reemplazar un MFA activo exige el código actual |
| Intentos de acceso | Sin límite | 5 fallos por usuario o 20 por IP en 15 min → HTTP 429 con `Retry-After`; también 5 códigos TOTP erróneos |
| Cookies | `Secure` desactivado por defecto | `Secure`, `HttpOnly`, `SameSite=Strict` por defecto |
| CSRF | Origen comprobado solo si el navegador enviaba `Origin`; `/login` y `/logout` sin control | Todo `POST/PUT/PATCH/DELETE` exige `Origin` o `Referer` del mismo host |
| Cabeceras | Solo en rutas autenticadas, sin CSP ni HSTS | CSP, HSTS, `X-Frame-Options`, `nosniff`, `Referrer-Policy`, `Permissions-Policy` en todas las respuestas |
| Host | Sin control | Lista blanca opcional con `MASCLI_ALLOWED_HOSTS` |
| Frontend | Identificadores de registros dentro de `onclick="f('…')"` permitían inyectar JavaScript | Argumentos serializados con `jsq()` (JSON + escape HTML) |

## Variables de entorno

| Variable | Valor por defecto | Uso |
|---|---|---|
| `MASCLI_ADMIN_USERNAME` / `MASCLI_ADMIN_PASSWORD` | `admin` / (obligatoria, ≥12 caracteres) | Cuenta inicial |
| `MASCLI_REQUIRE_MFA` | `1` | `0` solo para pruebas locales aisladas |
| `MASCLI_COOKIE_SECURE` | `1` | `0` si un navegador local por HTTP no guarda la sesión. Con `1` también se envía HSTS |
| `MASCLI_ALLOWED_HOSTS` | (vacío = sin control) | En despliegue: dominio(s) públicos separados por comas, p. ej. `mascli.ejemplo.org` |

Clientes no navegador (scripts) deben enviar la cabecera `Origin: https://<host>` en solicitudes que modifican datos.

## Pruebas

```
pip install -r requirements-dev.txt
python -m pytest -q tests
```

## Pendiente antes de desplegar

- **Almacenamiento duradero**: la base operativa, `auth_global.db`, tenants, configuración y adjuntos siguen en disco local/efímero (`/tmp` en Render free). Un reinicio en Render borra cuentas y datos. Requiere elegir disco persistente o base gestionada.
- El limitador de intentos es en memoria: válido para una sola instancia.
- La CSP aún permite `'unsafe-inline'` en scripts y estilos porque la interfaz usa manejadores en línea; eliminarlo exige migrar esos manejadores a `addEventListener`.
- No hay códigos de recuperación de MFA: si un usuario pierde su autenticador, un administrador debe restablecerlo directamente en la base de autenticación.
