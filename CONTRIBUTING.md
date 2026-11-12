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

## Trabajar desde un fork

Este repositorio es la fuente de verdad del producto. Quien tiene su propia instancia
([own-instance.es.md](docs/deployment/own-instance.es.md)) trabaja en un fork, y el código circula
en dos direcciones:

| Dirección | Cómo |
| --- | --- |
| Mejoras de este repositorio hacia el fork | Sincronizar el fork (abajo). Su CI despliega solo en sus cuentas. |
| Cambios del fork hacia este repositorio | Pull request desde una rama del fork. Si el cambio solo sirve a esa instancia, se queda en el fork. |

Sincronizar, desde el clon del fork:

```sh
git remote add upstream https://github.com/Dreamcoder08/sipges.git   # una sola vez
git fetch upstream --tags
git merge v1.1.0          # una versión etiquetada (ver CHANGELOG.md), o upstream/main
git push origin main      # dispara el despliegue del fork
```

Reglas para que el fork no se separe del producto:

- Lo que distingue a una instancia (dominio, base, cuentas, proveedor de IA, pesos del IRSA) va
  en variables y configuración, no en cambios de código.
- Los cambios de código que sirven a todos suben como pull request pronto, aunque sean chicos.
- La producción de un fork se actualiza a versiones etiquetadas, no a cada commit de `main`.
- Los pull requests desde un fork no tocan `.engram/`: esa memoria puede contener contexto de
  datos reales. El check «Fork PR guard» los rechaza.
- Nunca se suben datos reales. Para reproducir un problema se arma un caso con datos sintéticos.

Las críticas y las ideas entran como issue con las plantillas «Crítica o problema» e «Idea o
mejora». Una que se va a trabajar se vuelve una feature en `odd/tasks/`, con las palabras de quien
la pidió citadas como especificación.
