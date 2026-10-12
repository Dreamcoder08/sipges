# 0002 — Hexagonal architecture and bounded contexts

## Context
`app.py` mixes HTTP, SQL, filesystem, crypto and domain rules in 2,273 lines. Analysis engines are untestable without a database, and tenant routing is a global mutable variable (`SCOPE_DB`).

## Decision
Ports and Adapters (Alistair Cockburn) organized by bounded context (Eric Evans, DDD), in the "explicit architecture" style (Herberto Graça):

```
apps/api/src/
  contexts/<context>/
    domain/          entities, value objects, pure policies — no I/O imports
    application/     use cases (one class/function per command/query) + port interfaces
    infrastructure/  adapters: Drizzle repositories, crypto, storage, extractors
    http/            Hono routes: parse with contracts, call use case, map result
  platform/          config, logger, database pool, tenant context, middleware
  main.ts            composition root: wires adapters into use cases (manual DI)
```

Dependency rule (enforced by dependency-cruiser): `domain` imports nothing outside `domain` and `packages/kernel`; `application` imports `domain` and its own ports; `infrastructure` and `http` depend inward; contexts talk only through exported application APIs, never through each other's tables.

Bounded contexts (from behavior contract §7): Identity & Access, Tenancy, Territorial Records, Evidence, Indicators & IRSA, Strategic Analytics, Document Lab, Digital Intelligence, Prevention, Management Reporting, Reference Data.

Patterns used deliberately, not decoratively:
- **Result type** for expected failures (no exceptions across layers); exceptions only for bugs.
- **Repository** + **Unit of Work** (transaction carrying tenant context).
- **Strategy** for analysis engines and classifiers (versioned, swappable).
- **Adapter** for Ollama, object storage, document extraction (ADR 0005).
- **Specification/Policy** objects for role gates and state machines (prevention, review).
- Manual constructor injection in `main.ts` — no DI container or decorators.

## Consequences
- Engines become pure functions over typed records, testable in milliseconds and benchmarkable (T12).
- More files than the Python version; each is small and owns one reason to change.
- Cross-context reads (e.g. Management reads Prevention) go through query ports, keeping a future service split possible without committing to microservices now.

## References
Cockburn "Hexagonal Architecture"; Evans "Domain-Driven Design"; Graça "DDD, Hexagonal, Onion, Clean, CQRS… How I put it all together"; Vernon "Implementing DDD".
