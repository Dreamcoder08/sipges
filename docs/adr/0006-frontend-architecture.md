# 0006 — Frontend architecture

## Context
`static/app.js` and `index.html` (1,141 lines) use inline event handlers, string-built HTML (attribute-context injection at `app.js:223`, `:278`), client-only project switching and raw error toasts.

## Decision
- **React 19 + Vite**, **TanStack Router** (type-safe routes, search params validated with Zod) and **TanStack Query** (server state, caching, invalidation). No global client store unless a real need appears.
- **Feature-based structure** (inspired by Feature-Sliced Design / Bulletproof React):
  ```
  apps/web/src/
    app/        providers, router, layout
    features/   <feature>/{api,components,hooks,model}  — one per bounded context screen
    shared/     ui primitives, api client, lib
  ```
  Features never import each other's internals.
- **Typed API client** generated from `packages/contracts` Zod schemas; every response parsed at the boundary.
- **Security:** JSX escaping only (no `dangerouslySetInnerHTML`), no inline scripts/handlers, strict CSP; 401 redirects to login; project switching calls the server (`POST /select-project`).
- **UX:** accessible by default (semantic HTML, labelled forms, keyboard navigation, WCAG 2.2 AA target), CSS Modules over design tokens (CSS custom properties), route-level code splitting.
- **Tests:** Vitest + Testing Library for components, MSW for API mocks, Playwright for flows.

## Consequences
- Screens are rebuilt, not ported line by line; visual parity is judged per screen in T11.

## References
React docs, TanStack docs, Bulletproof React, Feature-Sliced Design, OWASP XSS Prevention Cheat Sheet, WCAG 2.2.

## Addendum (2026-10-14): basemap tiles for the territorial map

The territorial map draws public OpenStreetMap raster tiles from
`https://tile.openstreetmap.org/{z}/{x}/{y}.png`. The former CARTO Voyager endpoint returned
HTTP 200 images containing “API KEY REQUIRED” during visual verification, so a successful
HTTP status alone did not prove that the basemap rendered.

`img-src` names only `https://tile.openstreetmap.org` as an external image origin in the SPA
and Vercel policies; scripts, styles and connections remain same-origin. Browser documents
use `strict-origin-when-cross-origin`, sending the public app origin without paths or queries
to the tile service. The API middleware retains `no-referrer` for API responses. Normal browser
caching honors the tile service's response headers. The linked attribution “© OpenStreetMap
contributors” remains visible under the map, including on mobile.

This personal academic demo uses normal interactive views, without prefetch, bulk downloads
or offline tile export. CI substitutes a local image response for public tiles; actual imagery
is checked separately in the preview browser. For larger usage, choose a suitable hosted or
self-hosted provider rather than relying on this best-effort community service.

Policy checked on 2026-10-14: [OSMF Tile Usage Policy](https://operations.osmfoundation.org/policies/tiles/).
