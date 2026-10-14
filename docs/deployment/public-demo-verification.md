# Comprobación de la demo académica

Fecha: 2026-10-13. URL: https://mascli-demo-academica-agurtofarfanalbert-8641s-projects.vercel.app/login

Código: `70d2c40ed6ec7c24c2895889890716168aed4587`. Despliegue Vercel: `dpl_82Q51rFoAhxYALtRchiTDD8pbyC9`, READY. La integración Neon del propietario proporciona la conexión de producción. La configuración temporal anterior no está en uso. No se migran datos reales.

- SPA/login/CSP/banner: OK
- API/PostgreSQL/migrations/bootstrap: OK
- Password login / persisted account / Secure HttpOnly Strict cookie: OK
- MFA required before account administration: OK
- Session persists across reload: OK
- Mobile viewport: no overflow
- Logout / session revocation: OK
- Browser JavaScript: no page errors

La prueba inició sesión con la administración sintética, comprobó el bloqueo MFA y revocó la sesión. No preparó ni inscribió un autenticador para el propietario. Las credenciales se le entregan por un archivo privado fuera del repositorio.

Pendientes: inscribir MFA en el primer acceso; después comprobar CRUD sintético, autorización entre proyectos, evidencia Blob con descarga idéntica, PDF/DOCX y comparación en la URL pública. La CI con PostgreSQL real aprobó las 29 pruebas E2E (ejecución `38477948969`), pero no comprueba el almacén Blob de este despliegue.

El entorno de ejecución no permite TCP saliente directo (lista TCP vacía); las solicitudes de Playwright se hicieron desde Chromium por el proxy del entorno. La conexión PostgreSQL se comprobó desde Vercel, no mediante `psql` local.
