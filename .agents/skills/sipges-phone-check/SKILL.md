---
name: sipges-phone-check
description: "Use when SIPGES web layout or CSS changes may affect phones, the user shares mobile screenshots or mockups, or a screen overflows 360 px."
---

# Comprobar en teléfono

La e2e levanta su propia instancia con PGlite: no hace falta PostgreSQL.

1. `pnpm --filter @sipges/web build` (la e2e sirve el SPA compilado; recompila tras cada cambio).
2. Los specs `*.mobile.spec.ts` corren solo en el proyecto `mobile-chromium` (Pixel 7, 412 px): `cd apps/e2e && pnpm exec playwright test --project=mobile-chromium <archivo>`.
3. Capturas: spec temporal `tests/zz-shot.mobile.spec.ts` con `signInToProject(page, admin, DEFAULT_SCOPE)` y `page.screenshot({ path: <scratchpad> })`. Bórralo al terminar; nunca guardes capturas en el repo. Emula `colorScheme` **antes** de navegar: cambiarlo con la página cargada muestra transiciones a medias.
4. Test de regresión (RED antes del arreglo): `scrollWidth <= clientWidth` a 360 px, el borde derecho de los controles clave ≤ 360, textos largos forzados (nombres de proyecto) y axe WCAG AA en claro y oscuro.
5. Cierre: suite móvil completa `--project=mobile-chromium` y `sipges-verify`.

Causas de desborde ya vistas:
- Texto suelto dentro de un `inline-flex` no se encoge: usa `display: block` con `text-overflow: ellipsis`.
- Pistas de grid `auto` crecen al min-content: `grid-template-columns: minmax(0, 1fr)`.
- Hijos flex con texto largo: `min-width: 0`.
- Chip elegido fuera de la fila deslizable al llegar por enlace: `ChipRow` lo desplaza a la vista; con `scroll-snap-type: x proximity`, `scrollIntoView({ inline: 'nearest' })` lo dejó cortado en las pruebas, así que se alinea al inicio.

Cobertura: `tests/hubs.mobile.spec.ts` recorre cada pestaña de los destinos, `/objeto` y las hojas abiertas a 360 y 412 px en claro y oscuro; amplíalo al añadir una pestaña u hoja.

Cortes: teléfono `max-width: 40rem`, tableta `60rem`; usa `--tabbar-height` y `env(safe-area-inset-*)`. ADR: `docs/adr/0015-mobile-first-shell.md`.

Referencias: [skills de Claude Code](https://code.claude.com/docs/en/skills), [skills de Codex](https://developers.openai.com/codex/skills/).
