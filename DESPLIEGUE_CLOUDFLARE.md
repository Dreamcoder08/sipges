# Publicar MASCLI con Cloudflare Tunnel + Access

Ruta elegida en la tarea ODD: MASCLI corre en la PC de la oficina y Cloudflare lo publica en
`https://<subdominio>` sin abrir puertos. Dos barreras protegen el acceso: **Cloudflare Access**
(correo autorizado) y el **login de MASCLI con MFA**. La PC y el servidor deben permanecer encendidos.

> Nunca use un *Quick Tunnel* (`cloudflared tunnel --url …`): crea una URL pública sin Access.

## Requisitos (una sola vez)

1. Cuenta de Cloudflare con un dominio propio administrado en Cloudflare (por ejemplo `ejemplo.org`).
2. `cloudflared` instalado (`winget install Cloudflare.cloudflared`) y Python 3.12.
3. En PowerShell, dentro de la carpeta de MASCLI:

```powershell
cloudflared tunnel login                       # abre el navegador para autorizar el dominio
cloudflared tunnel create mascli               # crea el túnel y su JSON de credenciales
cloudflared tunnel route dns mascli mascli.ejemplo.org
```

4. Copie `deploy\cloudflare\config.example.yml` a `%USERPROFILE%\.cloudflared\config.yml` y complete
   `<TUNNEL_ID>`, `<USUARIO>` y el subdominio.
5. En el panel **Cloudflare Zero Trust → Access → Applications → Add → Self-hosted**:
   - Dominio: `mascli.ejemplo.org`
   - Política *Allow* con **Emails** = lista de personas autorizadas (o el dominio de correo de la empresa).
   - Duración de sesión: 8 horas o menos.

## Arranque

```powershell
powershell -ExecutionPolicy Bypass -File deploy\cloudflare\iniciar_mascli_tunel.ps1 -Hostname mascli.ejemplo.org
```

- En el primer arranque pide la contraseña inicial del administrador (no se guarda).
- Los datos quedan en `%LOCALAPPDATA%\MASCLI\data` (bases, cuentas, adjuntos, ajustes). Haga copia de
  seguridad de esa carpeta.
- Al entrar por primera vez, cada usuario registra su autenticador en `/mfa-setup`.

## Verificación tras publicar

1. Abrir `https://mascli.ejemplo.org` en una ventana privada: debe aparecer primero la pantalla de Cloudflare Access.
2. Tras Access, el login de MASCLI; luego `/mfa-setup` o el código del autenticador.
3. `https://mascli.ejemplo.org/health` (tras Access) responde `{"status":"ok"}`.
4. Reiniciar la PC y el script: las cuentas y datos siguen ahí.

## Recuperación

- Usuario sin autenticador: un administrador usa `POST /system/auth/accounts/<usuario>/reset-mfa`.
- Administrador sin autenticador o sin contraseña (en la PC, con la misma `MASCLI_DATA_DIR`):

```powershell
$env:MASCLI_DATA_DIR = "$env:LOCALAPPDATA\MASCLI\data"
.\.venv\Scripts\python.exe manage.py reset-mfa admin
.\.venv\Scripts\python.exe manage.py set-password admin
```
