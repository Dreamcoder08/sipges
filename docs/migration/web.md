# Web application (T11)

The React SPA in `apps/web` replaces `static/index.html` and `static/app.js` (ADR 0006).
Screens are rebuilt, not ported line by line, and land in four steps:

| Step | Screens |
| --- | --- |
| T11a | Shell, sign-in with MFA, project selection and switch, dashboard |
| T11b (implementado) | Eventos, Actores, Directorio, Demandas/Compromisos, Narrativas, Fuentes y evidencias vinculadas |
| T11c | IRSA, Alertas, Mapa, Análisis situacional, Inteligencia estratégica (document lab), Validación |
| T11d | Centro gerencial, Inteligencia de redes, Administración, Auditoría, Metodología |

Screens not rebuilt yet show an "En migración" notice inside the shell.

## Structure

```
apps/web/src/
  app/       providers, router, shell layout, navigation, global styles and tokens
  features/  auth, tenancy, dashboard, records: typed API access, components and pure models
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

## Territorial records and linked evidence (T11b)

The six rebuilt routes use the isolated `features/records` feature. Each module has its own field definition, labels and list columns; demands also offers commitments. The shared UI supports search, create, view, full-replacement edit and confirmed delete. Lists use the API's 500-record ceiling and explain when the reader should refine the search. Tables scroll inside a labelled keyboard-focusable region on narrow screens.

- Every record query key includes the authorized company/project. HTTP calls send `X-MASCLI-Scope`, including the fresh GET before PUT, uploads and downloads, so a request started before a project switch remains scoped to its original tenant.
- The router keys the workspace by scope/module. A project switch discards the old form and detail panel. Server grants, role policies and RLS remain authoritative.
- Admin and analyst can mutate these records; consultation and coordinator roles see read-only controls. The UI locks conflicting record controls during saves, deletes and uploads.
- PUT reads the latest record and overlays only editable fields, retaining unknown fields, IDs and evidence links. Existing project display names are preserved; new records use the granted project label when available. Explicitly blank canonical directory fields override imported aliases, so clearing a contact value remains effective.
- The delete confirmation announces its consequences, traps keyboard focus, supports Escape/cancel and restores focus when possible. Save/upload errors retain the draft or selected file for retry. A 401 clears session state and returns to sign-in.
- Evidence is a separate operation on a saved record: open its detail, choose a file and submit metadata. A rejected upload does not recreate the territorial record. Attachment answers use the shared `Attachment` contract. Binary downloads fetch the canonical API route with the same scope, then use a local Blob URL; returned `download_url` values are ignored.
- Narrative links allow only HTTP(S) without credentials; imported unsafe URLs remain escaped text. No HTML rendering or scraping is introduced.

### T11b parity differences retained for later phases

Event dimensions are selected explicitly in the editor. The legacy automatic `/system/analyze` step is not wired into this screen; its TypeScript API remains available for the later assisted-analysis UI. Directory aliases are enumerated rather than fuzzy-matched against arbitrary source column names; unknown fields are preserved by edits, while broader import normalization belongs with T13 migration tooling. Sources can be created before attaching a file, making failed uploads retryable on the same record.

Verification and synthetic-browser evidence: [T11b verification report](t11b-verification.md). These flows do not complete T11c/d, T12 benchmarks, T13 migration tooling or T14's comprehensive parity and deployment readiness.
