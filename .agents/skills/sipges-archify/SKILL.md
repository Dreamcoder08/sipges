---
name: sipges-archify
description: "Use when SIPGES architecture, ODD milestones, or pinned code references change and the Archify JSON, viewer and documentation must be refreshed. Excludes the territorial concession map and frontend feature design."
---

# Actualizar el mapa Archify

Lee `docs/ARQUITECTURA.md`, `docs/diagrams/arquitectura.json`, ODD y código implicado. Representa el runtime TypeScript realmente implementado, con pendientes explícitos. La geometría territorial es otra función y no pertenece a este diagrama.

Comprueba la revisión de la herramienta indicada en la guía. Actualiza JSON, tarjetas y referencias al código. Fija `meta.repository.revision` a un commit que ya contenga todos los archivos y rangos citados; conserva referencias comprobables y no añadas tecnologías solo propuestas.

Desde la raíz, con la herramienta clonada en una carpeta hermana:

```bash
ARCHIFY_UPDATE_CHECK_DISABLED=1 node ../archify-tool/archify/bin/archify.mjs finalize architecture docs/diagrams/arquitectura.json docs/diagrams/arquitectura.html --repo-root . --quality showcase --json --out-dir /tmp/sipges-archify-new-review
```

Usa una carpeta de recibos nueva para cada candidato. Conserva bytes HTML generados y licencia; revisa fuente, generación e integridad. Inspecciona escritorio/móvil, etiquetas, fuentes Git, tema y menú de exportación. Guarda la captura PNG y registra SHA-256 del HTML y revisión de fuente en `docs/VERIFICACION.md`.

Si `browser-check` falla con `ERR_BLOCKED_BY_ADMINISTRATOR` por `file://`, registra esa comprobación como fallida. Puedes añadir una prueba independiente por HTTP local; no la presentes como aprobación del gate geométrico integrado ni de los formatos exportados. No cambies la política del navegador para obtener verde.

Entrega artefactos, revisiones, hashes, resultados por gate y límites. Aplica `sipges-task-pr` para subir la documentación al PR correspondiente.

Referencia: [skills oficiales de Codex](https://developers.openai.com/codex/skills/). Herramienta: [tt-a1i/archify](https://github.com/tt-a1i/archify); procedimiento del repositorio: `docs/ARQUITECTURA.md`.
