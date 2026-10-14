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

## Addendum (2026-10-14): INGEMMET mining cadastre on the project location map

At the owner's request, the project location screen overlays INGEMMET's public mining cadastre
from GEOCATMIN (`SERV_CATASTRO_MINERO` MapServer, WGS 84). The browser requests one transparent
`export` image per view (`bbox` in lon/lat, `layers=show:0`, no credentials), drawn under the
project concessions; a checkbox hides it and the note links to the GEOCATMIN viewer. `img-src`
adds `https://geocatmin.ingemmet.gob.pe` in the SPA and Vercel policies; scripts, styles and
connections stay same-origin, and the request carries only the app origin as referrer. The
layer is referential, as INGEMMET states. E2E resolves the host to nothing, like the OSM tiles.

## Addendum (2026-10-14): satellite basemap and smooth map gestures

At the owner's request ("la ubicación geoespacial debe verse bien, realista"), both maps offer a
basemap choice: satellite, streets (the OSM tiles above) or none. Satellite imagery is EOX's
Sentinel-2 cloudless 2020 mosaic from
`https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless-2020_3857/default/g/{z}/{y}/{x}.jpg`, without
key or token, licensed CC BY-NC-SA 4.0 for this non-commercial academic demo, with the linked
credit "Sentinel-2 cloudless 2020 de EOX IT Services GmbH (contiene datos modificados de
Copernicus Sentinel 2020)" under the map. Its resolution is about 10 m per pixel, so the client
requests at most level 14 and stretches it closer in. The project location screen opens on
satellite; the territorial map keeps streets by default. `img-src` adds
`https://tiles.maps.eox.at` in the SPA and Vercel policies; E2E resolves it to nothing.

During a drag, pinch or Ctrl + wheel gesture the view lives in a ref and only an SVG transform
on the map content changes, once per animation frame; React renders once when the gesture ends.
The tile layer loads a quarter of the view beyond each edge and keeps the previous level's tiles
underneath until the new level loads. Profiling a drag with 4× CPU throttling showed the real
cost was rasterising district outlines whose CSS dash (0.01 map units, about 1 m) produced
millions of dashes; dashes are now sized to the view (p95 frame 267 ms → 17 ms).

## Addendum (2026-10-14): caching hashed assets

Vite names every JS and CSS file by its content hash, so `/assets/*` is served with
`Cache-Control: public, max-age=31536000, s-maxage=31536000, immutable` by the SPA middleware
and in `vercel.json`. Every other response keeps `no-store`: the HTML shell (so a deploy is seen
at once), the service worker, API data and errors. The security middleware only lets that exact
asset value through. Measured on 4G with a 4× slower CPU, a reload went from 1.6 s and 724 KB
to 0.9 s and 49 KB. Signed-in navigation reuses the cached session and project (refreshed in the
background, refetched when invalidated) and preloads the other screens' code while idle, except
under Save-Data.
