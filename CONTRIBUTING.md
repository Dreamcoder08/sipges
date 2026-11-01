# Contribuir a SIPGES

La versión final de SIPGES es el monorepo TypeScript (`apps/`, `packages/`). La app Python (`app.py`, `static/`) es legada: solo recibe correcciones de seguridad hasta que la migración alcance paridad.

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
python -m pytest -q tests   # solo si tocas la app Python legada
```

Las pruebas de integración con PostgreSQL real corren en CI. En local, actívalas con `SIPGES_TEST_DATABASE_URL` (ver `docs/migration/workspace.md`).

Las decisiones de arquitectura van como ADR en `docs/adr/`.
