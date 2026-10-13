# Architecture Decision Records

Format: [Michael Nygard ADR](https://cognitect.com/blog/2011/11/15/documenting-architecture-decisions) — context, decision, consequences. One decision per file; superseded ADRs stay and link forward.

| ADR | Title | Status |
|---|---|---|
| [0001](0001-monorepo-and-toolchain.md) | Monorepo and toolchain | Accepted |
| [0002](0002-hexagonal-architecture-and-bounded-contexts.md) | Hexagonal architecture and bounded contexts | Accepted |
| [0003](0003-persistence-and-tenant-isolation.md) | Persistence and tenant isolation | Accepted |
| [0004](0004-identity-and-session-security.md) | Identity and session security | Accepted |
| [0005](0005-processing-ports-and-native-adapters.md) | Processing ports and Go/Rust adapter policy | Accepted |
| [0006](0006-frontend-architecture.md) | Frontend architecture | Accepted |
| [0007](0007-http-contract-and-errors.md) | HTTP contract compatibility and errors | Accepted |
| [0008](0008-behavior-contract-corrections.md) | Corrections to Python behavior defects | Accepted |
| [0009](0009-internet-exposure-hardening.md) | Internet exposure hardening | Accepted |

Behavioral baseline: [`docs/migration/behavior-contract.md`](../migration/behavior-contract.md).
