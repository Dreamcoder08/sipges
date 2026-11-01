# Changelog

Formato basado en [Keep a Changelog](https://keepachangelog.com/es-ES/1.1.0/); versiones con [SemVer](https://semver.org/lang/es/).

## [Sin publicar]

### Privacidad

- Guarda de envío a IA externa ([ADR 0030](docs/adr/0030-external-ai-egress-guard.md)): el servidor MCP, el resumen asistido y los embeddings a una URL no local pasan por una sola guarda. Interruptor por proyecto «Envío a IA externa» (apagado por defecto, solo administradores, en Configuración); apagado, las herramientas de lectura de MCP responden con error, el resumen asistido no se genera y esos embeddings se rechazan. Encendido, solo salen los campos permitidos de cada módulo, con seudónimos estables por proyecto en lugar de nombres, y correos, teléfonos y DNI quedan tapados. Los registros restringidos nunca salen, ni con una clave de autorización plena. Cada envío deja una fila en Auditoría (módulo «IA externa») con ids y conteos, sin valores. Los embeddings de un Ollama local no cambian. Los proveedores de embeddings deben declarar `egress: 'local' | 'external'`. Sin migración: el ajuste vive en `project_settings`.

### Interfaz

- Página «Integraciones» (`/integraciones`, enlace de la barra lateral): una sola página con buscador, filtros Todos/Conectores/Skills/Programadas y selector «Tuyos»/«Descubrir». Cada tarjeta muestra tipo, etiqueta Integrado/Personalizado, estado y la acción que abre la gestión que ya existe (medios RSS, Defensoría, GEOCATMIN, claves MCP, webhook de ingesta, canales, reglas y procesamiento); las skills son las pantallas de análisis actuales y así se rotulan. «Claude vía MCP» advierte «Datos sintéticos hasta aprobar política de datos (Ley 29733)». `/automatizaciones` sigue funcionando; sin cambios de API, datos ni permisos.
- Cinco destinos en la navegación ([ADR 0015](docs/adr/0015-mobile-first-shell.md)): Inicio, Registros, Territorio, Bandeja y Análisis agrupan las pantallas actuales como pestañas enlazables (`?tipo=`, `?vista=`); la barra lateral añade «Integraciones» y «Recientes» y el móvil muestra Inicio, Registros, Bandeja y Territorio. Las rutas anteriores siguen funcionando; sin cambios de datos ni permisos.
- Registros unificado ([ADR 0015](docs/adr/0015-mobile-first-shell.md)): `/registros` abre una lista con chips por tipo y su cantidad (`?tipo=`, nuevo valor `todos` por defecto para ver Eventos, Actores, Directorio territorial, Demandas, Narrativas, Fuentes y Buzón juntos), con la verificación A–E y la validación como chips y filtros, y densidad cómoda/compacta por pestaña que dura solo la sesión del navegador. «Ver» abre el registro en un panel lateral con sus vínculos, el historial de cambios y el enlace «Abrir ficha completa»; crear, importar, editar y eliminar siguen igual. Sin cambios de API, datos ni permisos.
- Bandeja › «Pendientes»: una sola bandeja de decisiones con lo que espera una decisión en el proyecto activo (alertas territoriales por validar o confirmar, observaciones de calidad de datos y situaciones sin alerta; la plantilla de validación de expertos no entra porque nunca se resuelve y «Validación» sigue como su propia pestaña), agrupado por urgencia, con edad y teclado primero (J/K, Enter, Esc; A/R solo si la acción existe y está permitida). Las alertas se aprueban o rechazan con la misma revisión de Inteligencia de redes; la regla de cuatro ojos sigue en el servidor y la interfaz no ofrece «Aprobar» a quien hizo la primera validación. Sin cambios de API.
- Inicio con compositor ([diseño 01](design/workspace-architecture/01-inicio-composer.html)): `/inicio` abre en una pestaña «Inicio» (Dashboard y Centro gerencial siguen como pestañas) con un saludo, el compositor «Pregunta a SIPGES», cuatro preguntas sugeridas y un briefing tranquilo con lo que espera tu decisión (alertas activas, hacia Bandeja), los eventos de los últimos 7 días (hacia Registros) y el riesgo IRSA del territorio (hacia Territorio). Enviar una pregunta no llama a ningún modelo: abre la búsqueda global con el texto escrito; las respuestas con citas llegan después. Una tarjeta cuyo dato no carga se oculta. Sin cambios de API, datos ni permisos.
- Inicio en el teléfono como una app de chat (ChatGPT, Claude): el saludo queda centrado, el briefing pasa a filas de una línea que llevan a Bandeja, Registros y Territorio, las preguntas sugeridas forman una sola tira deslizable y el compositor «Pregunta a SIPGES» descansa sobre la barra inferior con el proyecto como chip. Desde 641 px no cambia nada. Solo presentación: sin cambios de API, datos ni permisos.
- Registros fiel a la maqueta ([ADR 0015](docs/adr/0015-mobile-first-shell.md)): la lista «Todos» tiene una sola barra de filtros (búsqueda, verificación A–E, validación, densidad y «N de M registros») y la tabla va directo en la página, sin tarjeta; Tipo, verificación y validación son chips (el tipo con su icono, un «—» tenue solo cuando falta el dato); «Importar» y «Nuevo registro» abren un selector de tipo que lleva al formulario o a la importación CSV de ese tipo; desde 1280 px la ficha del registro se acopla a la derecha de la lista sin bloquearla (Esc la cierra y devuelve el foco) y por debajo sigue como hoja modal. Solo presentación: sin cambios de API, datos ni permisos.
- Barra lateral compacta en pantallas anchas ([ADR 0015](docs/adr/0015-mobile-first-shell.md)): «Fijados» (Dashboard, Eventos, Alertas, Mapa territorial, Validación) y tres secciones plegables de las que solo se abre la de la pantalla actual, sin repetir pantallas fijadas. La búsqueda (Ctrl K), las notificaciones y el selector de proyecto pasan de la barra superior a la barra lateral; las pantallas de Sistema, el tema y «Cerrar sesión» quedan en el menú de la cuenta, al pie. En el teléfono no cambia nada.
- Menú de la cuenta corto, como el de Claude ([ADR 0015](docs/adr/0015-mobile-first-shell.md)): nombre completo y usuario, Configuración (atajo Ctrl+, o Cmd+,), Administración, Auditoría, Ayuda y metodología y «Cerrar sesión»; «Automatizaciones» sale del menú porque «Integraciones» ya lleva a esa pantalla. El tema pasa a Configuración → «Apariencia», disponible para todos los roles ([ADR 0018](docs/adr/0018-design-system-tokens-and-themes.md)), también en el teléfono. Se guarda en el dispositivo como hasta ahora.

### Plataforma

- Cloudflare Workers (Hyperdrive + Neon, R2) es el único host de SIPGES: se elimina el adaptador `apps/hosting` y las dependencias `@vercel/*`, y la documentación vigente deja de describir la demo de Vercel como publicada ([ADR 0029](docs/adr/0029-retire-vercel-host.md)). El endpoint HTTP de cron y `SIPGES_CRON_SECRET`/`CRON_SECRET` no cambian. La base `neondb` de la demo anterior se conserva en Neon como respaldo, sin migrar datos.
- Migración `0031_remove_mascli_tenant`: elimina el proyecto `MASCLI/PRJ-SECHURA` que el Worker anterior volvió a crear tras el cambio de nombre y que hacía aparecer Sechura dos veces al elegir proyecto. Si no tiene datos se borra con sus permisos; si los tiene, pasan a `SIPGES/<proyecto>` y, ante una clave repetida, la migración falla y revierte sin borrar nada. También renombra el nombre visible «Administración MASCLI Workers» a «Administración SIPGES» (solo coincidencia exacta).
- Migración `0032_rename_admin_username`: la cuenta de administración `mascli-admin` pasa a llamarse `sipges-admin` (resto del cambio de nombre MASCLI → SIPGES). Conserva rol, contraseña, vínculo con Google, permisos, suscripciones push y sesiones abiertas, y renombra en cada columna de autoría (auditoría, historial, vínculos, evidencias, decisiones, ajustes, claves de API, etc.) solo el valor exacto, de modo que la regla de cuatro ojos sigue viendo a una sola persona. Los payloads JSON y los textos libres no se reescriben. Si `sipges-admin` ya existe, o queda el nombre antiguo en alguna columna de texto fuera de la lista revisada, la migración falla y revierte sin cambiar nada; sin `mascli-admin` no hace nada. Requiere actualizar el secreto `SIPGES_ADMIN_USERNAME` del Worker a `sipges-admin`.

## [1.0.0] - 2026-10-15

Primera versión publicada de SIPGES en TypeScript, desplegada en Vercel desde `main`.

### Plataforma

- Monorepo TypeScript con arquitectura hexagonal: API Hono, SPA React/Vite, contratos Zod compartidos y PostgreSQL con RLS por proyecto (#3, #4, #24).
- Identidad: sesiones, Argon2id, TOTP cifrado, límites de intentos, MFA obligatorio, comprobación de origen y entrada con Google para cuentas invitadas (#5, #12, #35).
- Proyectos y permisos con aislamiento por tenant y exportación por alcance (#7).
- Despliegue gratuito en Vercel con evidencias privadas en Blob (#32, #41).

### Funcionalidad

- 14 módulos de registros con CRUD, auditoría, importación CSV, evidencias, vínculos, historial y vista 360° (#8, #13, #42).
- IRSA, indicadores y analítica estratégica (#9).
- Ontología e inteligencia: búsqueda híbrida, grafo, clasificación, analista y cronología (#42).
- Automatizaciones, notificaciones push e integración por API y MCP (#43).
- Interfaz mobile-first, mapas interactivos con mapa satelital y catastro GEOCATMIN (#37, #45, #46, #47).
- Cada módulo probado de punta a punta en escritorio y teléfono; app más fluida con caché de recursos (#44, #48).
- Tendencia temporal de narrativas por día y categoría; tablas con teléfonos y prioridades en una línea (#49).

### Datos

- Se retiró el caso académico sintético de la base (migración 0019) y del código: solo queda la información real del proyecto (#49).

## Pre-1.0 — Python prototype

Antes de v1.0.0 SIPGES fue un prototipo FastAPI + SQLite (RC 1.3 → 3.0 y v0.4 → v0.5.1). Su historial está resumido en [docs/history/python-prototype.md](docs/history/python-prototype.md); las notas originales se conservan en [`reference/python/history/`](reference/python/history/).

[1.0.0]: https://github.com/Dreamcoder08/sipges/releases/tag/v1.0.0
