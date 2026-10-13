# Web application (T11)

The React SPA in `apps/web` replaces `static/index.html` and `static/app.js` (ADR 0006).
Screens are rebuilt, not ported line by line, and land in four steps:

| Step | Screens |
| --- | --- |
| T11a | Shell, sign-in with MFA, project selection and switch, dashboard |
| T11b | Eventos, Actores, Directorio, Demandas, Narrativas, Fuentes (evidence uploads) |
| T11c | IRSA, Alertas, Mapa, Análisis situacional, Inteligencia estratégica (document lab), Validación |
| T11d | Centro gerencial, Inteligencia de redes, Administración, Auditoría, Metodología |

Screens not rebuilt yet show an "En migración" notice inside the shell.

## Structure

```
apps/web/src/
  app/       providers, router, shell layout, navigation, global styles and tokens
  features/  auth, tenancy, dashboard: api.ts (queries), components, model.ts (pure logic)
  shared/    api client, UI primitives, text helpers
  test/      MSW server with synthetic data and test setup
```

Features never import each other (dependency-cruiser `web-features-are-isolated`). Only `app/`
composes them; features receive callbacks (`onSignedIn`, `renderLink`) instead of knowing the
route tree.

## API access

- `shared/api/client.ts` calls the API same-origin with `credentials: 'same-origin'`. The
  session and the active project live in HttpOnly cookies; the SPA never handles tokens.
- Every answer is parsed with its `@mascli/contracts` schema. New client-facing contracts:
  `DashboardResponse`, `IrsaSummary`, `ModelStatus`.
- A failure becomes an `ApiError` whose `detail` is shown as text. FastAPI-style validation
  lists are summarised, never rendered raw.
- A 401 from any query or protected mutation clears the cache and opens the sign-in screen,
  keeping the current path as a same-app `redirect`.
- Project switching posts to `/select-project` and refetches everything. The legacy client-only
  switch (`localStorage`) is gone (behavior contract §6, decision 5).

## Sign-in

`/login` posts the form to `POST /login`. The OTP field appears once the server answers that a
code is required, and accepts digits only. After sign-in the user returns to the page they
asked for. Absolute or protocol-relative redirects are ignored. Several projects and none
selected leads to `/proyecto`.

## Delivery and security

- `MASCLI_WEB_DIR` (for example `apps/web/dist` after `pnpm --filter @mascli/web build`) makes
  the API serve the SPA. HTML navigations to non-API paths get `index.html`. `/assets/*` serves
  hashed files with validated names. API paths, JSON requests and writes are untouched.
- The shell and bundle are served without a session because they hold no tenant data. Every
  data call still needs a session and a project.
- SPA responses carry a strict CSP. It allows only `'self'` scripts and styles, no inline code,
  `connect-src 'self'` and `frame-ancestors 'none'`. Bar widths use React's `style` prop, which
  goes through the CSSOM and is allowed. The favicon is a `data:` image.
- JSX escaping only: no `dangerouslySetInnerHTML`, no inline handlers.

## Accessibility

- The page has a skip link and a labelled navigation landmark that marks the current page with
  `aria-current`.
- One `h1` per screen. Focus moves to it after navigation and the document title follows it.
- Forms have labelled fields with linked hints. Errors use `role="alert"` and loading states
  use `role="status"`.
- Bar charts are description lists, so the numbers are text and the bars are decoration.
- Small screens get a menu toggle with `aria-expanded`; Escape closes it. Motion is reduced on
  request.

## Intentional differences

- **Dashboard scope:** counters come from the active project only. The legacy dashboard mixed
  global counters with project charts.
- **Profile:** the name and role come from the session. The legacy header hard-coded a person.
- **Code splitting:** the bundle is one chunk (about 140 kB gzip). Route-level splitting comes
  with the heavier screens in T11c.

## Tests

`pnpm --filter @mascli/web test` covers the following with Vitest, Testing Library and MSW on
synthetic data:
- sign-in, MFA and the redirect guard;
- session expiry and sign-out;
- project selection and switching;
- dashboard data, navigation focus and the mobile menu;
- the API client.

The API side has tests for `/api/dashboard` and for SPA delivery and its CSP
(`apps/api/test/platform/spa.test.ts`).
