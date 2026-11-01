# Mobile drawer shell (ChatGPT / Claude mobile)

Phones and tablets lose the context bar icons and the bottom bar: a menu button opens a left drawer that
holds the same sidebar as wide screens. Branch `feat/mobile-drawer-shell`; delivery: one PR, auto-merge;
tests: Vitest (web) and Playwright (`mobile-chromium`).

## Specs

- S1 — «corrije el diseño ui & Ux el navbar superior y los iconos , quiero que todos ellos deberian estar en el sidebar mobile , asi como lo hace chat gpt mobile y claude mobile» (screenshots: SIPGES Inicio on a phone with the project context, search and avatar in the top bar and the five-item bottom bar; Claude and ChatGPT mobile drawers listing sections, pinned items and recents, with search and the account in the drawer).
- S2 — Chosen option, verbatim: «Quitarla, como ChatGPT» — «Todo vive en el panel lateral: destinos, fijados, recientes, proyecto y cuenta. La pantalla queda limpia, pero cambiar de destino cuesta un toque más.»
- S3 — On compact screens (≤ 60rem) the top bar holds only a menu button and the page title. The menu opens a left drawer with the project selector, search, notifications, the five destinations, Integraciones, Recientes and the account menu (the wide-screen sidebar). No bottom bar.
- S4 — The drawer is a modal dialog: focus moves to the current destination, Escape and the backdrop close it, focus returns to the menu button, and choosing a destination navigates and closes it.

## Tasks

- T1 — S1–S4: drawer shell, removal of the bottom bar and of the phone-only account sheet (`AccountMenu`), tests (AppShell unit, `mobile.spec.ts`, e2e fixtures) and ADR 0015 addendum. Route: inline. Commit: this branch (PR below). Status: done.

## Log

- L1 — S1 verbatim, 2026-11-01.
- L2 — S2: the owner chose to remove the bottom bar (question asked with ASCII previews of both options).
- L3 — T1 done. RED: two new compact tests in `AppShell.test.tsx` failed against the bottom-bar shell. GREEN: web 125/125 in `src/app`; Playwright `mobile-chromium` 24/24; chromium 78/79 at first: `18-territorial-intelligence` (phone) exposed that a query-only navigation (`?alert=`) left the drawer open, fixed by closing it on any location change; rerun 2/2. `pnpm verify` exit 0.
