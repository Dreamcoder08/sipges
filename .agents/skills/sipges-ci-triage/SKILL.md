---
name: sipges-ci-triage
description: "Use when a SIPGES PR or main has a failing, blocked or slow CI check, auto-merge is stuck, or Deploy Workers did not run after a merge."
---

# Diagnosticar la CI

`main` exige 8 checks; Deploy Workers corre solo cuando CI pasa en `main`. Una corrida normal dura ~5 min.

1. Lee la tabla completa: `gh pr checks <n>`. Nunca la filtres con `| tail` antes de decidir. Si recién hiciste push y no aparecen 8 checks, espera a que se registren antes de `--watch`.
2. Por cada fallo: `gh run view <run> --log-failed | grep -E "Error|✘|failed|Expected|Received"`. Para e2e, baja los artefactos a un directorio temporal (`gh run download <run> -D <scratch>`) y mira `playwright-report*/test-results/*/test-failed-1.png`.
3. Clasifica:

| Causa | Acción |
| --- | --- |
| Infraestructura: `address already in use`, daemon de Docker, red, runner perdido | `gh run rerun <run> --failed`; no toques código |
| Código | Reproduce el mismo proyecto y ancho; test primero (RED), arregla, GREEN |
| Pasa al reintentar sin cambios (flaky) | No lo ignores: encuentra la carrera, fíjala con un test y guárdala en Engram |

4. Diferencias local/CI conocidas: el proyecto `mobile-chromium` es Pixel 7 (412 px) pero `mobile.spec.ts` revisa 360 px; las fuentes de CI (DejaVu) son más anchas, así que fuerza textos largos en vez de confiar en la fuente local.
5. Tras el arreglo: push y vuelve al paso 1. Informa por check: causa, acción y resultado.

Referencias: `.github/workflows/ci.yml`, [skills de Claude Code](https://code.claude.com/docs/en/skills), [skills de Codex](https://developers.openai.com/codex/skills/).
