# Arquitectura visual de MASCLI

El [mapa Archify](diagrams/arquitectura.html) explica el recorrido desde la interfaz hasta el almacenamiento. Es una vista de componentes lógicos: las funciones de acceso, API y análisis conviven en `app.py`, dentro de la misma aplicación FastAPI. No representa servicios desplegados por separado.

## Cómo leer el mapa

1. La interfaz `static/` realiza peticiones HTTP a la API.
2. El middleware verifica la sesión, el rol y el alcance autorizado de empresa/proyecto. Las rutas públicas y el selector de proyecto tienen tratamiento específico.
3. Las rutas de la aplicación consultan o modifican registros, calculan indicadores e IRSA, o extraen y revisan texto documental.
4. SQLite conserva datos y auditoría; los JSON aportan configuración, y los adjuntos se escriben en el sistema de archivos.

Cada componente incluye referencias a archivos y líneas fijadas al commit `c442ebf23fc11f612746d53a11f2f3b470790fa0`. El mapa documenta esa revisión; no consulta infraestructura ni datos de usuarios en tiempo real.

## Responsabilidades y persistencia

| Componente | Implementación | Almacenamiento o entrada |
| --- | --- | --- |
| Interfaz | `static/index.html`, `static/app.js`, `static/style.css` | Respuestas JSON; selección visible en `localStorage` |
| Acceso | `auth_identity`, `enforce_auth`, login y selector | Usuarios, sesiones y grants en `auth_global.db` |
| Registros | Rutas `/api/{module}` | Tabla `records` y cambios en `audit` |
| Análisis | `compute_indicators`, definición final de `compute_irsa` | Registros del alcance y configuración JSON |
| Laboratorio documental | `doc_extract`, `document_insights` y rutas de revisión | Texto en memoria; extractos importados en `document_review` |
| Evidencias | `/system/uploads`, `upload_root` | Archivo local, metadatos y SHA-256 en SQLite |

`MASCLI/PRJ-SECHURA` utiliza la base principal. Otros alcances utilizan archivos en `data/tenants/<hash>.db`; las configuraciones se copian a `<hash>_settings` cuando se consultan. `MASCLI_DB_PATH`, `MASCLI_AUTH_DB_PATH`, `MASCLI_TENANT_DIR` y `MASCLI_UPLOAD_DIR` permiten cambiar esas ubicaciones. El proyecto visible en la interfaz no sustituye el alcance autenticado por el servidor.

El laboratorio analiza PDF con texto, DOCX, TXT y Markdown mediante reglas léxicas locales. No incorpora OCR ni IA generativa. Sus resultados son candidatos: la importación y la decisión de revisión son operaciones explícitas. La corroboración documental exige una nota. El IRSA usa reglas y proxies pendientes de validación externa, como declara su respuesta actual.

## Archivos editables y regeneración

- `diagrams/arquitectura.json`: fuente tipada, geometría, relaciones y referencias.
- `diagrams/arquitectura.html`: visor autónomo generado; no editarlo manualmente.
- [Licencia del visor Archify](ARCHIFY-LICENSE.txt): atribución de la herramienta original.

Se utilizó [tt-a1i/archify](https://github.com/tt-a1i/archify), revisión `c21c31ffb879668900c5487ea24993bf45d89b15`. Archify necesita Node.js 18 o posterior y Chrome/Chromium para su comprobación de navegador. Es una herramienta de documentación, no una dependencia del servidor MASCLI.

Para reproducir la generación, clona Archify en una carpeta hermana y fija su revisión:

```bash
git clone https://github.com/tt-a1i/archify.git ../archify-tool
git -C ../archify-tool checkout c21c31ffb879668900c5487ea24993bf45d89b15
```

Desde la raíz de MASCLI:

```bash
ARCHIFY_UPDATE_CHECK_DISABLED=1 node ../archify-tool/archify/bin/archify.mjs finalize architecture \
  docs/diagrams/arquitectura.json docs/diagrams/arquitectura.html \
  --repo-root . --quality showcase --json --out-dir /tmp/mascli-archify-review
```

En PowerShell, establece primero `$env:ARCHIFY_UPDATE_CHECK_DISABLED="1"` y ejecuta el comando `node` en una línea. Usa una carpeta de revisión nueva si cambias la fuente; conserva los recibos anteriores como evidencia. El comando devuelve un código distinto de cero cuando falla una etapa.

Para actualizar el mapa tras un cambio de código, inspecciona las funciones afectadas, actualiza sus referencias y fija `meta.repository.revision` al commit que contiene ese código. Ajusta las relaciones y las tarjetas antes de regenerar. Las fuentes se verifican contra los archivos comprometidos en Git, por lo que no deben citar cambios sin commit como si pertenecieran a la revisión fijada.

## Comprobación de esta entrega

Las etapas automáticas de validación, generación y comprobación estricta de Archify pasaron. Su etapa `browser-check` falló al abrir el archivo local porque el Chromium de este entorno bloquea URLs `file://` (`ERR_BLOCKED_BY_ADMINISTRATOR`). Esto impide afirmar que `finalize` pasó todas sus etapas. La prueba HTTP adicional que se describe en [la verificación](VERIFICACION.md) es independiente y no sustituye ese recibo.

El mapa cubre la arquitectura general. Las rutas de prevención, consenso, inteligencia territorial e informes se agrupan dentro de la aplicación; no se representa cada endpoint ni se certifican seguridad, aislamiento o validez científica.
