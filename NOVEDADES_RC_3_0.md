# MASCLI RC 3.0 — Aislamiento por empresa/proyecto y MFA TOTP

## Alcance
Esta versión continúa sobre RC 2.9. Incorpora un directorio central de cuentas y permisos (auth_global.db), y una base SQLite independiente para cada nuevo par empresa/proyecto (`data/tenants/<hash>.db`). El proyecto histórico `MASCLI/PRJ-SECHURA` conserva la base anterior (`data/mascli.db`). Los archivos adjuntos nuevos se segregan por proyecto y el motor IRSA usa configuración separada por proyecto.

## Primer inicio
Configure MASCLI_ADMIN_USERNAME y MASCLI_ADMIN_PASSWORD (mínimo 12 caracteres) antes de arrancar. Por defecto use `python -m uvicorn app:app --host 127.0.0.1 --port 8000` en la carpeta del código. En despliegue HTTPS configure `MASCLI_COOKIE_SECURE=1` y certificados TLS en el proxy.

## Empresas y proyectos
Inicie sesión como administrador. Para crear un usuario: `POST /system/auth/accounts` (username, full_name, password, role). Para crear un proyecto separado: `POST /system/auth/scopes` (company_id, project_id, label, username). Para dar acceso a un usuario existente: `POST /system/auth/grants` (username, company_id, project_id). Cada usuario solo puede seleccionar proyectos autorizados desde `/select-project`. El servidor elige la base correspondiente; rechaza scopes ajenos. API: `GET /system/auth/scopes`, `GET /system/auth/current-scope`. Los proyectos nuevos empiezan con registros operativos vacíos y una ficha de proyecto; no copian los registros semilla de Sechura.

## Autenticación de dos factores
Con la sesión abierta: `POST /system/auth/totp/setup` devuelve la clave y URI `otpauth://`. Agregue la clave en una aplicación compatible con TOTP (p. ej., Aegis, Google Authenticator, Microsoft Authenticator). Verifique un código: `POST /system/auth/totp/enable` con JSON `{"code":"123456"}` usando el código vigente, no el ejemplo. Desde entonces la pantalla de acceso pide usuario, contraseña y código TOTP de seis dígitos. La función usa SHA1/TOTP de 30 segundos conforme a la interoperabilidad habitual; la clave no debe enviarse a terceros.

## Pruebas ejecutadas
Se ejecutaron pruebas locales: bloqueo sin sesión; creación de dos empresas y proyectos; aislamiento lectura cruzada (404); rechazo de escritura en proyecto ajeno (403); alta de usuario; activación TOTP; acceso denegado con solo contraseña; acceso con contraseña y TOTP; sintaxis Python y JavaScript.

## Limitaciones relevantes
RC 3.0 **no está certificada para producción**. Los controles de seguridad requieren auditoría de todos los endpoints, cobertura completa de autenticación/autorización y pruebas de concurrencia; el directorio central es un administrador global con permisos de creación de tenants. Todavía faltan protección avanzada contra fuerza bruta, recuperación segura del segundo factor, cifrado de secretos TOTP en reposo, supervisión, respaldos cifrados, rotación de claves, CSP y endurecimiento de infraestructura. El modelo SQLite por proyecto es apropiado para piloto local, no equivale a una arquitectura SaaS empresarial probada. No exponga información sensible o datos reales de actores sin consentimiento, base jurídica y controles adecuados.
