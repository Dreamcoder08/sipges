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
| Frontend | Identificadores de registros dentro de `onclick="f('…')"` permitían inyectar JavaScript; CSP imposible sin `'unsafe-inline'` | Sin JavaScript en línea: acciones declarativas `data-on-*` (JSON, solo datos) y scripts externos; la CSP prohíbe scripts en línea |
| MFA perdido | Sin recuperación | Un administrador restablece el MFA de otra cuenta (`POST /system/auth/accounts/<usuario>/reset-mfa`); en el servidor, `python manage.py reset-mfa <usuario>` |
| Almacenamiento | Bases, cuentas, tenants y ajustes repartidos entre `data/` del repo y `/tmp` | Todo bajo `MASCLI_DATA_DIR`; aviso al arrancar si está en `/tmp` |
| Dependencias | Rangos abiertos | Versiones fijadas y auditadas con `pip-audit`; CI en GitHub Actions |

## Variables de entorno

| Variable | Valor por defecto | Uso |
|---|---|---|
| `MASCLI_DATA_DIR` | `data/` del proyecto | Carpeta persistente para todo el estado (bases, cuentas, tenants, ajustes, adjuntos) |
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

- Publicación: seguir `DESPLIEGUE_CLOUDFLARE.md` (requiere iniciar sesión en Cloudflare desde la PC y un dominio en Cloudflare).
- Render (pausado): el plan gratuito no tiene disco persistente; si se retoma, montar un disco y apuntar `MASCLI_DATA_DIR` a él.
- El limitador de intentos es en memoria: válido para una sola instancia.
- La CSP mantiene `'unsafe-inline'` solo para estilos (atributos `style=`), de bajo riesgo.
