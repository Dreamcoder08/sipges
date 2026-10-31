# Runners de pruebas de API y web

API y web deduplican `vitest` mediante `resolve.dedupe` en
[`apps/api/vitest.config.ts`](../../apps/api/vitest.config.ts) y
[`apps/web/vite.config.ts`](../../apps/web/vite.config.ts). Con pnpm, dos
instancias de la misma versión con distintos peers pueden separar el contexto
del runner del utilizado al registrar hooks. No se deben retirar los hooks de
limpieza ni ampliar los timeouts para ocultar ese fallo.

## Comprobación focalizada

Desde la raíz, ejecutar en serie, sin otros tests ni builds simultáneos:

```bash
cd apps/api && env -i PATH="$PATH" HOME="$HOME" LANG=C.UTF-8 ./node_modules/.bin/vitest run test/config.test.ts
```

La regresión observada sin deduplicación es `Vitest failed to find the current
suite` en `test/support/test-database.ts:13`, con cero pruebas recolectadas y
salida 1. Con deduplicación, el mismo comando aprueba 36 pruebas y sale con 0.
La versión local y la raíz eran ambas 5.0.4, pero sus rutas físicas de pnpm
correspondían a instancias distintas. Vite resuelve los paquetes deduplicados
desde la raíz de la aplicación, en lugar de depender del importador.

El test de tooling `API app-local Vitest registers shared cleanup hooks in the
active runner` ejecuta ese comando mediante el binario local de la API, con
entorno limpio, y comprueba la salida y la ausencia del error de contexto. No
consulta el historial de Git ni requiere datos reales o conexiones externas.

## Setup de web

Desde la raíz, ejecutar sin otros tests ni builds simultáneos:

```bash
cd apps/web && env -i PATH="$PATH" HOME="$HOME" LANG=C.UTF-8 ./node_modules/.bin/vitest run src/app/navigation.test.ts
```

Sin deduplicación, este comando falla al registrar `beforeAll` en
`src/test/setup.ts:27` con `Vitest failed to find the runner`: salida 1, un
archivo fallido y cero pruebas recolectadas. Con la única adición de
`resolve.dedupe: ['vitest']`, aprueba las seis pruebas, incluido el setup de
jsdom/MSW, y sale con 0. El setup y sus hooks no se modifican.

El test de tooling `web app-local Vitest registers setup hooks in the active
runner` ejecuta ese mismo archivo con el binario local y entorno limpio.
Comprueba salida 0, un archivo aprobado, pruebas aprobadas y ausencia de error
de contexto u omisiones, sin fijar el total cambiante de pruebas. Se puede
comprobar por separado desde la raíz:

```bash
env -i PATH="$PATH" HOME="$HOME" LANG=C.UTF-8 node --test --test-name-pattern='web app-local Vitest' scripts/tooling.test.mjs
```

## Ejecución serial y estado asíncrono de web — S7

La configuración web limita `maxWorkers` a 1 y desactiva `fileParallelism`.
Ejecutar comandos uno detrás de otro no impide que Vitest ejecute muchos
archivos jsdom y cargue sus rutas lazy simultáneamente. Se conserva el
aislamiento entre archivos; no se amplían timeouts ni se omiten pruebas.

Probe acotado, desde la raíz:

```bash
cd apps/web && env -i PATH="$PATH" HOME="$HOME" LANG=C.UTF-8 ./node_modules/.bin/vitest run src/app/AuditRegressions.test.tsx src/app/Evidence.test.tsx src/app/ObjectView.test.tsx src/app/RecordInsights.test.tsx src/app/Records.test.tsx src/app/Timeline.test.tsx src/features/notifications/DevicePush.test.tsx
```

Los siete archivos originales aprobaron 48/48 tanto con la concurrencia por
defecto como con `--maxWorkers=1 --no-file-parallelism`. Por tanto, el probe no
reprodujo los seis timeouts de 5 segundos del gate de 65 archivos. La contención
durante la carga simultánea sigue siendo una hipótesis, no una causa demostrada.
La configuración hace efectiva la ejecución serial; su efecto sobre esos seis
fallos requiere la verificación completa web del orquestador.

En `DevicePush.test.tsx` sí se reprodujo una carrera de forma determinista al
retener la respuesta MSW hasta observar la petición: el contador de peticiones
ya era 1, pero la UI aún mostraba «Consultando suscripción del dispositivo…».
La prueba ahora libera esa respuesta y espera el mismo texto final «Los avisos
push no están configurados», además de conservar la ausencia de checkbox y la
única petición. No se modifica el componente, el setup ni el límite de espera.
Tras ambos cambios, el probe acotado aprueba 48/48, incluido ese caso con
respuesta controlada. Este resultado no sustituye la verificación completa.

## Cierre de recursos de API

```bash
cd apps/api && env -i PATH="$PATH" HOME="$HOME" LANG=C.UTF-8 ./node_modules/.bin/vitest run test/platform/test-app-lifecycle.test.ts test/platform/verify-failed-setup.test.ts
```

Estas cinco pruebas conservan el cierre entre tests, el aislamiento de cuentas
y el cierre de clones cuyo setup falla. Las comprobaciones `afterAll` también
observan el cierre del último clon, que no tiene un test posterior. Se mantienen
los hooks originales, un único worker y los límites de 20 segundos. Los datos
son sintéticos y PGlite se ejecuta en memoria.

La advertencia de Node sobre `localStorage` sin `--localstorage-file` puede
aparecer también en una ejecución aprobada; no es el error de contexto.
Estas comprobaciones focalizadas no sustituyen el gate completo serial de T5
en [el ODD de integración](../../odd/tasks/integration-consolidation.md).
