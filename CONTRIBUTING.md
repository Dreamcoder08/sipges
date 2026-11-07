# Contribuir a SIPGES

SIPGES es un monorepo pnpm (`apps/`, `packages/`, `engines/`) que avanza hacia un backend Go, motores Rust y un frontend TypeScript ([ADR 0032](docs/adr/0032-go-backend-rust-engines.md)). La app Python (`reference/python/`) es la especificación de comportamiento legada; no recibe funciones nuevas.

## Ramas

- `main` es la única rama de larga vida. Siempre está verde y desplegable.
- Todo cambio entra por pull request; nada se empuja directo a `main`.
- Ramas cortas desde `main`, nombradas por tipo: `feat/…`, `fix/…`, `docs/…`, `refactor/…`, `test/…`, `chore/…`.
- Se borran al fusionarse (GitHub lo hace solo con "Automatically delete head branches").
- PRs apilados (`feat/x-01`, `feat/x-02`…) se fusionan de abajo hacia arriba; tras fusionar uno, el siguiente cambia su base a `main`.

## Commits

[Conventional Commits](https://www.conventionalcommits.org/): `tipo(ámbito): resumen en imperativo`, p. ej. `fix(auth): make session cookies secure by default`.

## Antes de abrir un PR

```sh
corepack enable
pnpm install --frozen-lockfile
pnpm check              # lint + límites de capas + typecheck + tests
PYTHONPATH=reference/python python -m pytest -q reference/python/tests   # solo si tocas la app Python legada
(cd apps/api-go && go test ./...)   # solo si tocas Go
(cd engines && cargo test --locked)   # solo si tocas Rust
```

Las pruebas de integración con PostgreSQL real corren en CI. En local, actívalas con `SIPGES_TEST_DATABASE_URL` (ver `docs/migration/workspace.md`).

Las decisiones de arquitectura van como ADR en `docs/adr/`.
