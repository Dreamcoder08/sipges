# Architecture guardrails

Keep dependencies pointing inward, build abstractions for real needs, and compose the UI from reusable, token-based parts. These are working guardrails, not a claim that the whole repository has been certified.

## Dependency direction

- Domain expresses rules without infrastructure, database or framework dependencies. Application orchestrates domain behavior through ports; HTTP and infrastructure adapt external inputs and services to those ports.
- For example, `apps/api/src/contexts/records/application/ports.ts` defines `RecordStore`, `Clock` and `RandomHex`; `apps/api/src/contexts/records/infrastructure/sql-record-store.ts` implements the store with a tenant transaction. `apps/api/src/compose.ts` supplies that adapter, a clock and randomness to the records service. `apps/api/src/main.ts` is the startup composition root: it opens the database and builds the application.
- A rule that protects stored data belongs to the use case, not to each adapter. The records service applies the per-module id rule (`validatePayload`) in `create` and `replace` and returns an `invalid` error; the HTTP routes, the MCP `create_record` tool and analyst proposals only translate that error into their own format. Adapters may still pre-check for their own reasons, as the ingest webhook does to refuse a whole batch before writing any of it.
- Purity does not forbid deterministic parsing of a supplied date: `apps/api/src/contexts/integration/domain/feeds.ts` parses an input timestamp. Reading the ambient clock or randomness is different; supply those effects from outside the domain.
- `.dependency-cruiser.cjs` checks domain imports, application-to-adapter direction, context and web-feature isolation, web-to-API imports and cycles. `pnpm boundaries` runs the existing boundary check. Import rules cannot prove absence of ambient effects or correctness of every adapter; a bounded manual sample is not an exhaustive purity audit.

Introduce a port when an actual external capability or substitution requires it, not one interface per class. Refactor as needs emerge; do not rewrite working contexts to fit a speculative template.

## UI composition in the existing tree

Atomic Design describes responsibilities, not mandatory directories or a migration plan:

| Role | Existing example | Responsibility |
| --- | --- | --- |
| Atom | `apps/web/src/shared/ui/Button.tsx`, `Icon.tsx` | Reusable control or visual primitive. |
| Molecule | `apps/web/src/shared/ui/Field.tsx` | Label, input and optional accessible hint together. |
| Organism | `apps/web/src/features/search/SearchPalette.tsx` | Search interaction, results and dialog composition. |
| Template | `apps/web/src/app/layout/AppShell.tsx` | Shared signed-in layout and navigation around page content. |
| Page | `apps/web/src/features/geography/GeographyPage.tsx` | Feature-specific data and map composition. |

Other components can span roles; classify by responsibility rather than name. Do not force five folders per feature or rename existing modules to match the vocabulary.

## Design tokens and map paint

Interface chrome consumes semantic colour tokens from `apps/web/src/app/styles/tokens.css`; use its existing primitive scales for spacing, type, radius and other non-colour dimensions. Map data paint also uses named `--map-*` tokens: cadastre legend, imagery outline, markers and concession fills. Theme-invariant paint is defined only in `:root`, so both dark-theme blocks inherit it unchanged. The raw-colour test in `apps/web/src/app/styles/tokens.test.ts` exempts only the token definition itself; every module, including the map stylesheets, must use tokens. The test matches a bounded set of CSS colour syntaxes and is not exhaustive certification. Colours set from TypeScript, such as SVG attributes, are outside its scope.

Reuse mature UI primitives when appropriate, adapting them to CSS Modules, semantic tokens and the existing CSP rather than adding a parallel design system. See [UI components](ui-components.md) for the shadcn/Radix dialog adaptation and CSP constraint.
