# Integración y consolidación de SIPGES

Diagnóstico inicial y auditoría P1–P4 autorizada, sobre el checkout `b2ad4f9`.
Sin correcciones de producto (P5), despliegues, datos reales ni activaciones externas.
Objetivo: evaluar SIPGES como un producto conectado y priorizar mejoras verificables, sin añadir módulos por defecto.

## Specs

- S1 — Petición original: «hey bro que mas falta para mascli ?? , he visto que mascli tiene un modulo de mascli 4.0 , se activa y mas , no deberia estar todo actualizado , conectado , y en la vanguardia ?? , eliminar redundancia , friccion , mejorar performance y mas ??».
- S2 — Petición de planificación: «yes ODD de integracion».
- S3 — Alcance inicial elegido: «Diagnóstico y plan ODD primero (recomendado)»; descripción presentada: «Contrastar código, tareas y evidencia; definir recorridos, redundancias y prioridades en un documento ODD. Sin cambiar comportamiento ni activar servicios.».
- S4 — Autorización posterior: «yes te autorizo and continue», en respuesta a la propuesta de ejecutar P1–P4 (auditoría y medición sintética antes de implementar correcciones).
- S5 — Continuación explícita: «aceto el informe , pero avanza con la verificacion completa y las mediciones». Se conserva el informe parcial y se ejecutan verificaciones completas y benchmark sin corregir código ni aumentar límites.
- S6 — Decisión posterior seleccionada: «Sí, completar T5 (recomendado)»; descripción: «Diagnosticar y corregir el runner; ejecutar después el gate completo en serie. Sin ampliar timeouts, omitir pruebas ni cambiar permisos del producto.». T6 sigue fuera de esta autorización.
- S7 — Autorización literal: «yes autorizo todo y ve de forma autonoma», en respuesta a la propuesta «abrir una unidad acotada para diagnosticar y corregir estos siete fallos web», sin aumentar timeouts, omitir pruebas ni cambiar expectativas para forzar el aprobado. No repetir API mientras su código/configuración permanezcan intactos.
- S8 — Autorización posterior literal: «continue», tras informar «Queda T6: resolver el 403 del harness para completar las mediciones HTTP/SQL». Se continúa T6 con datos sintéticos, sin relajar permisos ni usar conexiones reales.

## Tasks

T1–T3 corresponden al diagnóstico inicial; T4–T7 a la auditoría y medición autorizadas.
P5 permanece fuera del alcance. S6/S7 autorizaron la corrección de T5; S8 habilita ahora reparar el harness sintético y completar T6, sin cambios a permisos del producto.

- T1 [x] S1,S3 — Contrastar composición, controles 4.0, recorridos y evidencia existente; route: read-only exploration + parent spot check; commit: not requested
- T2 [x] S1,S2,S3 — Documentar hallazgos, hipótesis, prioridades y criterios de aceptación; route: inline documentation; commit: not requested
- T3 [x] S2,S3 — Comprobar estructura, referencias locales, formato y descubrimiento por odd:status; guardar espejo de memoria; route: inline structural verification; commit: not requested

- T4 [x] S4 — Reconciliar matriz de capacidades y preparar comprobaciones sintéticas seguras (P1); route: read-only exploration + inline evidence; commit: not requested
- T5 [x] S4,S5,S6,S7 — Verificación funcional completada por componentes seriales; API691/14, web283/283, hosting11 y tooling9; límites originales y evidencia conservados; route: scoped worker + independent review; commit: 6299b81
- T6 [x] S4,S5,S8 — Sesión MFA reparada, benchmark local completo0/36 escenarios, diferencial0 y runner local sin caché persistida4/4; route: scoped worker + serial benchmark + independent static review; commit: 3289896
- T7 [x] S4,S5,S6,S7,S8 — Cierre documental, evidencia y memoria de T5/T6; verificaciones y limitaciones explícitas; route: inline documentation; commit: T5 b811d8b; T6 3289896; closure metadata in following slice

## Corrección T5 — S6

- Corrección inicial S6: `apps/api/vitest.config.ts` y `apps/web/vite.config.ts` deduplican `vitest` con `resolve.dedupe`, sin cambiar dependencias, hooks, límites ni permisos. S7 añade después un solo worker web y desactiva paralelismo entre archivos; no cambia aislamiento ni aumenta timeouts.
- RED reproducido: binario local API sobre `test/config.test.ts`, salida 1 y cero pruebas por contexto de `afterEach`. El worker confirmó quitar/restaurar únicamente dedupe: mismo comando falla/pasa. Dos instancias físicas pnpm de la misma versión 5.0.4; no se afirma instrumentación exhaustiva del mecanismo upstream.
- GREEN focalizado: 1 archivo, 36 pruebas, salida 0 (2,39 s). Regresión pública en tooling: 1/1 aprobada tras RED. Lifecycle: 5/5 aprobadas en 2 archivos (14,96 s); conserva hooks y comprueba también el cierre del último clon mediante `afterAll`.
- Web: RED local en `src/app/navigation.test.ts`, salida 1/cero pruebas por contexto de `beforeAll` en setup. Tras añadir únicamente dedupe: GREEN salida 0, 1 archivo/6 pruebas (1,00 s), stderr vacío. Regresión pública web en tooling 1/1 aprobada; no fija el número total de pruebas.
- Documentación de reproducción y alcance: [runners de API y web](../../docs/testing.md).
- Gate completo posterior: evidencia del antiguo job-9 perdida tras discontinuidad del runtime; no se asume resultado. Nueva ejecución bajo «termina T5», con entorno limpio/PGlite y evidencia persistente en `odd/evidence/t5-verification/full-gate.log` y `full-gate.exit`: salida 1, API 97 archivos aprobados/5 omitidos, 691 pruebas aprobadas/14 omitidas (627,45 s). Web falla al cargar 65 suites, cero pruebas, `Vitest failed to find the runner` (29,25 s). Hosting/tooling posteriores no ejecutados. Se conserva la ejecución fallida y se investiga el runner web como continuación de T5. El navegador 93/1 no se repite porque no cambió código de producto.
- Riesgo: item 5 (configuración del entorno de pruebas). ASSESS solicitó verificador independiente; evaluación nativa no pudo determinar candidato por archivos sin seguimiento aún no declarados. Verificador independiente completó lectura estática y, después del gate anterior, comprobación funcional aislada: 2 regresiones públicas de runners aprobadas y hosting 4 archivos/11 pruebas aprobadas, sin cambios en el repositorio. No se reclama aprobación de revisión nativa ni del gate final.
- Gate final API+web: salida 1 tras 11 min 18 s; evidencia separada en `odd/evidence/t5-verification/full-gate-api-web.log` y `full-gate-api-web.exit`, sin sobrescribir el fallo anterior. Estáticos/tipos y kernel aprobados. API 97 archivos aprobados/5 omitidos, 691 pruebas aprobadas/14 omitidas (577,09 s). Web 58 archivos aprobados/7 fallidos; 276 pruebas aprobadas/7 fallidas (51,62 s). No hay fallo de carga del runner: ahora ejecuta las pruebas. Hosting y tooling posteriores no ejecutados por corte del gate, aunque las comprobaciones independientes previas aprobaron. No hubo otras baterías/builds simultáneos; esto no implica que la configuración web ejecute archivos con un solo worker.
- Fallos web observados: timeouts de 5.000 ms en `AuditRegressions.test.tsx:33`, `Evidence.test.tsx:40`, `ObjectView.test.tsx:12`, `RecordInsights.test.tsx:12`, `Records.test.tsx:28` y `Timeline.test.tsx:23`. `DevicePush.test.tsx:125` esperaba «Los avisos push no están configurados» y observó «Consultando suscripción del dispositivo…». S7 autoriza diagnóstico/corrección acotada sin cambiar ese resultado esperado ni aumentar límites.
- Evidencia S7: el probe de siete archivos originales pasó 48/48 con defaults (12,28 s) y con flags seriales (23,62 s): no reprodujo los seis timeouts, por tanto no demuestra su causa. Se configura web con `maxWorkers: 1` y `fileParallelism: false` para cumplir ejecución serial y acotar concurrencia, manteniendo dedupe/aislamiento/límites. Tras cambios, siete archivos 48/48 (24,04 s), stderr vacío.
- Carrera push demostrada: retener respuesta MSW hasta observar la petición hace fallar determinísticamente la aserción inmediata (RED 1 fallo/2 aprobadas). Contar la petición no prueba respuesta/renderizado. La corrección libera respuesta y usa `waitFor` con exactamente el mismo texto final, sin pausa arbitraria; refuerza ausencia de checkbox y petición única. No cambia componente/API ni debilita expectativas.
- Fullweb serial S7 aprobado: 65 archivos y 283 pruebas, salida 0 (129,51 s). Evidencia `odd/evidence/t5-verification/web-serial.log` y `web-serial.exit`. Los seis casos con timeouts previos aprobaron en esta ejecución; eso no establece por sí solo la causa del fallo histórico. API691/14 y navegador93/1 se conservan por no cambiar código afectado.
- Comprobaciones restantes aprobadas tras corregir formato: lint/formato, límites (733 módulos/2.162 dependencias), tipos de todos los paquetes, build web (4,10 s), hosting (4 archivos/11 pruebas) y tooling (9/9), salida 0 en `remaining-checks-formatted.log`/`.exit`. Persisten las advertencias de chunks superiores a 500 kB y Node localStorage; no se ocultan. El intento anterior `remaining-checks` falló solo por formato y también se conserva.
- T5 cerrada funcionalmente con prueba acumulada por componentes seriales sobre las fuentes correspondientes sin cambios posteriores de lógica en API/navegador; no se afirma que el último gate monolítico tenga salida 0. PostgreSQL real sigue omitido por falta de conexión sintética explícita; navegador Chromium escritorio/móvil emulado, no dispositivo físico/WebKit. [Resumen de evidencia](../evidence/t5-verification/README.md).
- Revisión independiente S7: sin hallazgos estáticos graves; confirmó seguridad del mismo texto final, aislamiento/configuración y logs de componentes. Su comando push final no se ejecutó por conflicto entre sus instrucciones de aislamiento en temporal del sistema y confinamiento del padre al proyecto. No se inventa una ejecución independiente: el padre ejecutó el comando focalizado, salida0/3pruebas (1,55s), evidencia `push-final.log`/`.exit`. Se conservan las comprobaciones funcionales independientes anteriores de regresiones API/web y hosting.
- Unidad de código propia: `6299b81fa6adfc1584a203aa4966dc04a6599b5d`, 7 archivos/156 líneas cambiadas, sin incluir cambios ajenos. ASSESS sobre rango committed-only también resultó unavailable/unassessable por rechazo de untracked no declarados; no devuelve reviewDue ni crea autoridad. No se repite ni se inventa continuación/aprobación nativa. Se siguió el plan de verificación independiente de riesgo5. No hubo push, PR ni despliegue.
- Mantenimiento no bloqueante señalado por el verificador: la regresión depende del texto del reporter y del recuento actual de 36 pruebas; usa lanzador POSIX; el `afterAll` de lifecycle puede añadir un TypeError secundario si falla el primer setup. Ningún punto prueba un falso aprobado o una pérdida de limpieza; no se amplía el cambio antes del resultado del gate.

## T6 — benchmark local completado, límites conservados

- Causa del 403 reproducida: login200 crea administrador sintético sin MFA inscrito y `requireMfa` sigue activo; dashboard403 contiene `mfa_required: true`. El log `/api/:module` no demuestra ausencia de ruta.
- El fixture compartido runner/regresión inscribe TOTP por setup/enable y selecciona proyecto autorizado; conserva ambas cookies, controles activos y fallo ante GET distinto de200. No hay cambios de guardas/permisos ni conexiones reales.
- Benchmark completo con entorno limpio y PGlite embebido: salida0,43s,36mediciones; siete rutas HTTP/SQL incluido,30iteraciones+3calentamientos sobre4.840registros. [JSON e índice](../evidence/t6-benchmark/README.md). MFA/migraciones/inserciones fuera del GET cronometrado.
- HTTP p95/bloqueo(ms): dashboard86,43/86,10; IRSA63,84/64,44; situational23,01/25,89; integrated36,34/43,96; consensus26,00/31,75; strategic25,99/34,42; eventos12,69/12,71. Todos p95<500; dashboard/IRSA exceden50ms de bloqueo. Salida0 no significa presupuesto aprobado ni justifica adaptador nativo.
- Comparativa `--quick --out` contra b811d8b en copia temporal dentro del proyecto: baseline403/salida1/sinJSON → actual200/salida0/JSON29mediciones; mismas22etiquetas/orden previos aHTTP,7HTTPcon5iteraciones ysin100×. Logs stdout/stderr/códigos retenidos; latencias/IDs/relojes no comparables byte a byte. Copia base retirada.
- Estáticos: lint/formato/límites735módulos2.169dependencias aprobados. Typecheck inicial TS2322 por JSONunknown se corrigió con validación explícita; tipos/lint/formato posteriores aprobados. Fullbenchmark previo sigue válido para el mismo setup exitoso y GETs sin cambio.
- Regresión worker RED1fallo → GREEN1aprobada con lanzador raíz. Padre observó incompatibilidad de contextos: raíz aprueba nueva1pero falla carga dashboard; local aprueba dashboard3pero falla carga nueva. Ambos fallos se conservan. Worker diagnosticó transforms persistidos que importan peerVitest raíz: mismo runner local/fuentes/configuración con `--no-fs-module-cache` aprueba2archivos/4pruebas,salida0,13,48s. Padre comprobó import absoluto en caché; no se borró caché ni se modificó T5config/deps/expectativas/límites. [Handoff atribuido](../evidence/t6-benchmark/worker-runner-handoff.md), no stdout independiente ni ejecución del padre. T6 completa como baseline sintético local, no gate global con caché aprobado.
- Revisión independiente estática y evidencia existente: sin hallazgos graves; no ejecutó pruebas nuevas. ASSESS unassessable por untracked no declarados, sin reviewDue/lineage/aprobación nativa. Riesgo item2: cliente MFA/credenciales sintéticas, guardas de producto intactas. No hubo push/PR/despliegue.
- Límites: HTTP en proceso `app.request`, SQL incluido en PGlite, no servidor PostgreSQL/red/carga concurrente/SQL aislado ni recuento de consultas. `situational-analysis` no es Situaciones4.0; aquella medición de servicio/memoria se conserva aparte. No se infiere regresión frente a hardware histórico ni cobertura total P4 de producción.

## Diagnóstico

### Resumen

La prioridad propuesta es consolidar lo existente, no construir otra versión paralela.
El repositorio contiene integración entre capacidades; no demuestra por sí solo su funcionamiento en producción.
El interruptor 4.0 es configuración por proyecto, no un instalador ni evidencia de obsolescencia del sistema.
No se ha demostrado captura duplicada de datos ni una regresión actual de rendimiento.

### Evidencia y límites

| Área | Observación | Evidencia local | Qué no demuestra |
| --- | --- | --- | --- |
| Activación 4.0 | La configuración es por proyecto, desactivada por defecto; las pantallas dependen del control | [ADR 0020](../../docs/adr/0020-sipges-4-situations.md), [settings](../../apps/api/src/contexts/situations/domain/settings.ts), [AppShell](../../apps/web/src/app/layout/AppShell.tsx) | Qué proyectos tienen el control activo en producción |
| Experiencia de versiones | La configuración presenta activar 4.0 o volver a 3.0 | [SettingsPage](../../apps/web/src/features/situations/SettingsPage.tsx) | Que el usuario deba elegir entre dos aplicaciones o que eliminar el control sea seguro |
| Situaciones → Alertas | El diseño reutiliza Alertas y requiere confirmación humana; no escribe alertas automáticamente desde el motor | [ODD 4.0](sipges-4-situations.md), [E2E 19](../../apps/e2e/tests/19-sipges.spec.ts) | Ejecución actual de esa prueba, despliegue o aceptación humana |
| Situaciones frente a operaciones | Agrupar señales por tema/actor/territorio y recorrer enlaces tipados son mecanismos distintos | [motor](../../apps/api/src/contexts/situations/domain/situations.ts), [dossier](../../apps/web/src/features/geography/operations.ts), [ODD operacional](territorial-operations.md) | Redundancia funcional o necesidad de fusionar ambos mecanismos |
| Entrada y automatización | Existen fuentes, evaluación, reglas y entregas; hay pruebas de recorrido en el repositorio | [ODD territorial](../tasks/territorial-intelligence-alerts.md), [E2E 18](../../apps/e2e/tests/18-territorial-intelligence.spec.ts), [E2E 10](../../apps/e2e/tests/10-automation-integration.spec.ts) | Disponibilidad actual de proveedores, recepción real o conexión universal entre todos los recorridos |
| RSS y fase | Implementación registrada; el cierre integrado sigue abierto en su documento | [ODD medios](media-monitoring-project-phase.md), [ADR 0021](../../docs/adr/0021-media-monitoring-and-project-phase.md) | Monitoreo de todas las redes ni consulta cada 30 minutos en el hosting: ser elegible para consulta no equivale a frecuencia del ejecutor |
| Rendimiento | Existe una mejora histórica medida; el servicio de Situaciones solicita registros de varios módulos antes de calcular el informe | [benchmarks](../../docs/benchmarks/README.md), [servicio](../../apps/api/src/contexts/situations/application/index.ts), [harness](../../apps/api/bench/run.ts) | Latencia actual de Situaciones, capacidad bajo carga o necesidad de caché/reescritura |
| Calidad y aceptación | Quedan fuentes originales, recuperación de documentos y aceptación real | [ODD calidad](../tasks/data-quality-relationships-followup.md) | Que automatizar pruebas recupere documentos o valide clasificaciones reales |

Las pruebas enlazadas son evidencia de cobertura existente, no resultados ejecutados en este diagnóstico.
Los logs históricos de navegación/móvil no se convierten en defectos actuales sin reproducción.
No se consultaron producción, datos reales, credenciales, proveedores remotos ni el estado remoto de PRs.

### Pendientes heredados: conservar su dueño

El inventario local anterior al nuevo documento mostró siete tareas abiertas en cuatro iniciativas.
No se cierran ni se duplican aquí; la primera propuesta debe reconciliar si sus logs quedaron atrasados.

| Iniciativa | Pendientes registrados | Tipo de prueba o decisión que falta |
| --- | --- | --- |
| [SIPGES](sipges-4-situations.md) | T8 | Separar cierre integrado, revisión, entrega y activación autorizada |
| [Monitoreo de medios](media-monitoring-project-phase.md) | T5 | Evidencia integrada y estado de entrega; activación sigue separada |
| [Inteligencia territorial](../tasks/territorial-intelligence-alerts.md) | T1, T2, T8 | Disponibilidad real GEOCATMIN, recepción en dispositivo y activaciones autorizadas |
| [Calidad de datos](../tasks/data-quality-relationships-followup.md) | T6 | Fuentes originales, documentos ausentes y aceptación de una usuaria real |

## Plan de auditoría — P1–P4 autorizadas; P5 pendiente

P1–P4 están autorizadas para auditoría y medición sintética. P5 no está aprobada.
El orden expresa dependencias de evidencia; no una promesa de alcance, fecha o solución técnica.

| Unidad | Prioridad y resultado | Criterio de aceptación para su futura ejecución |
| --- | --- | --- |
| P1 — Estado verificable | Primero: reconciliar capacidad implementada, probada, entregada, configurada y activada | Matriz por capacidad con commit/evidencia, entorno y estado desconocido explícito; enlazar el ODD propietario; no cerrar tareas por mera presencia de código |
| P2 — Recorridos conectados | Después de P1: verificar fuente → narrativa → evaluación → señal/alerta → acción → evidencia, y Situación → alerta confirmada | Escenarios sintéticos por cada recorrido realmente soportado; conservar IDs, origen y enlaces; comprobar persistencia visible, permisos, aislamiento, duplicados y fallos aplicables; diferenciar bandeja, aceptación del proveedor y recepción real |
| P3 — Navegación y fricción | Después de P1, en paralelo conceptual con P2: evaluar una experiencia SIPGES coherente | Inventario por rol y proyecto con 4.0 encendido/apagado; recorridos escritorio/móvil reproducibles; registrar captura repetida y pasos evitables solo cuando se observen; propuesta de nombres/agrupación antes de cambiarla |
| P4 — Rendimiento actual | Medir antes de optimizar; incluir Situaciones y los recorridos de P2 | Baseline reproducible sintético con hardware, volumen, p50/p95, bloqueo del event loop, consultas y coste de interacción; distinguir inicio frío/caliente y latencia externa; acordar presupuesto por recorrido antes de elegir mejoras; comparar misma carga antes/después |
| P5 — Simplificación y cierre | Solo con hallazgos de P2–P4: escoger correcciones demostradas y cerrar evidencia operativa | Cada cambio responde a una reproducción o medición; preserva contratos, revisión humana y controles de permisos; incluye regresión y documentos; reducción de pasos/duplicación o mejora medida sin resultados inventados |

### Reglas para convertir propuestas en implementación

- No fusionar Situaciones, señales, Alertas y notificaciones solo por nombres parecidos: documentar responsabilidad, estado y fuente de verdad de cada uno.
- No retirar el interruptor 4.0 ni activar capacidades por defecto sin decidir la compatibilidad y el control por proyecto.
- No introducir caché, nuevos proveedores, dependencias o una segunda tecnología sin evidencia que justifique la solución.
- Para cambios futuros de aislamiento, identidad, datos persistentes, concurrencia o exposición pública: unidad de trabajo propia y verificación independiente según el riesgo real.
- Usar datos sintéticos aislados en verificaciones; preservar confirmación humana de alertas y validación metodológica de colores/pesos.
- Las autorizaciones de despliegue, credenciales, consultas de datos reales y activación externa permanecen separadas de aprobar implementación.

## Auditoría ejecutada — evidencia incremental

### P1: matriz de estado local

| Capacidad | Implementación y cobertura identificadas | Prueba ejecutada en esta etapa | Entrega/configuración/activación de producción |
| --- | --- | --- | --- |
| Narrativa → evaluación → señal/bandeja | narrative-evaluation.test.ts, E2E 18 | Archivo API aprobado; E2E escritorio y viewport teléfono aprobadas | Desconocidas; no se consulta producción |
| Situaciones → alerta confirmada | SituationsPage/SettingsPage, E2E 19 | UI focalizada y E2E 19 aprobadas | Desconocidas; el control sigue siendo por proyecto |
| Operaciones → historial/evidencia | operations-http.test.ts, situation-room-http.test.ts | Verificación incompleta: 2 timeouts en el conjunto API | Desconocidas; URL de evidencia no acredita bytes recuperados |
| Navegación y roles | navigation.test.ts, E2E 14; E2E 18 incluye viewport móvil | Unitaria aprobada; E2E coordinador/consulta aprobadas; analista agotó 60 s en /fuentes | Desconocidas; viewport no equivale a teléfono físico |
| Rendimiento | Harness existente más medición de servicio Situaciones en memoria | Motores medidos; HTTP abortó con 403; Situaciones excede bloqueo a 10×/100× | No extrapolable a producción ni al hardware histórico |

Se comprobaron los requisitos de ejecución: API usa clones PGlite y dobles offline;
E2E crea PGlite temporal y credenciales sintéticas, requiere build y navegador disponible.
Los comandos se lanzan con entorno limpio para no heredar URLs, credenciales ni proveedores.
El harness existente no cubre el servicio/ruta de Situaciones 4.0: «Situational analysis» es otro motor.
No se modificará el harness en esta auditoría.

Entorno local: Node v26.7.0, Vitest 5.0.4, Linux x64, AMD Ryzen 5 4600H,
12 CPUs lógicas y aproximadamente 7 GiB de RAM. No es el entorno del benchmark histórico.

### S5: verificación completa y mediciones (nueva ejecución autorizada)

- Gate completo: `env -i PATH="$PATH" HOME="$HOME" LANG=C.UTF-8 bash scripts/verify.sh` — job-5, salida 1. Aprobaron ESLint/Prettier, límites (733 módulos/2.162 dependencias) y tipos de todos los paquetes. Pruebas previas: soporte E2E 10/10 y kernel 8/8. API: 44 archivos aprobados, 57 fallidos al cargar y 1 omitido; 313 pruebas aprobadas y 3 omitidas. Error dominante: `Vitest failed to find the current suite` en `test/support/test-database.ts:13` al registrar `afterEach`; también errores de contexto/configuración. No son 57 fallos funcionales demostrados. El gate interrumpió los paquetes posteriores y tooling: no se declaran aprobados ni ejecutados. No se modifica configuración ni se reintenta.
- Navegador completo: `cd apps/e2e && env -i PATH="$PATH" HOME="$HOME" LANG=C.UTF-8 ./node_modules/.bin/playwright test` — job-6, salida 0, 93 aprobadas y 1 omitida en 8,3 min. Omisión: captura opcional `screenshots.mobile.spec.ts` («capture the mobile shell»). Incluye Chromium escritorio y emulación móvil; no WebKit ni dispositivo físico. Esta ejecución completa aprobada no invalida el timeout previo ni explica su causa.
- Benchmark completo: `cd apps/api && env -i PATH="$PATH" HOME="$HOME" LANG=C.UTF-8 node bench/run.ts` — job-7, salida 1 tras 34 s. Midió motores a 1×/10×/100×, documentos y semántica sintética; la etapa HTTP abortó al primer `/api/dashboard` con 403, tras login 200 (`bench/run.ts:310`). No hay tiempos HTTP válidos ni se alcanzó la tabla final. No se elude autorización ni se atribuye causa sin diagnóstico. Se conservaron los valores emitidos antes del fallo.
- Situaciones 4.0: job-8, salida 0; servicio real con lector en memoria, 30 iteraciones y 3 de calentamiento por escala. Control activado, reloj fijo 2026-10-13 y lector filtrado por módulos solicitados. Sin HTTP/SQL, sin fixtures de lecciones ni buzón, sin servicios externos. Se corrigió la propuesta de instrumentación antes de ejecutarla: el módulo real es `Lecciones_Territoriales`, no `Lecciones`; no se envolvieron eventos como lecciones.

### P4: mediciones observadas

Valores en milisegundos, mismo entorno local descrito arriba. El benchmark principal usa 30 iteraciones para motores; PDF/semántica fría usan 10. El proveedor semántico es un doble de 40 ms, no un modelo real.

| Escenario | Escala | p95 | Bloqueo event loop |
| --- | --- | ---: | ---: |
| Indicadores + IRSA | 1× / 484 registros | 2,36 | 7,54 |
| Análisis situacional anterior | 1× | 0,24 | 0,24 |
| Enlaces candidatos | 1× | 0,89 | 0,98 |
| Análisis integrado | 1× | 1,27 | 1,93 |
| Consenso | 1× | 0,43 | 0,48 |
| Evaluación estratégica | 1× | 0,05 | 0,05 |
| Clasificación de 25 eventos | 1× | 1,89 | 2,12 |
| Indicadores + IRSA | 10× / 4.840 registros | 12,43 | 12,77 |
| Análisis situacional anterior | 10× | 0,68 | 0,76 |
| Enlaces candidatos | 10× | 1,62 | 2,66 |
| Análisis integrado | 10× | 6,51 | 7,11 |
| Consenso | 10× | 1,80 | 1,96 |
| Evaluación estratégica | 10× | 0,10 | 0,14 |
| Clasificación de 250 eventos | 10× | 17,32 | 18,72 |
| DOCX estratégico | 10× | 25,70 | 24,87 |
| Indicadores + IRSA | 100× / 48.400 registros | 54,28 | 55,07 |
| Análisis situacional anterior | 100× | 5,69 | 5,96 |
| Enlaces candidatos | 100× | 1,26 | 1,40 |
| Análisis integrado | 100× | 207,88 | 219,86 |
| Consenso | 100× | 176,83 | 182,05 |
| Evaluación estratégica | 100× | 1,16 | 1,83 |
| Clasificación de 2.500 eventos | 100× | 169,29 | 178,31 |
| Extracción PDF | 100 páginas | 345,00 | 3,00 |
| Insights, muchos temas | 100 páginas | 35,49 | 39,38 |
| Insights, sin temas | 100 páginas | 24,26 | 29,52 |
| Comparación de hallazgos | 72×72 | 4,06 | 5,21 |
| Análisis textual | Narrativas 10× | 1,80 | 1,90 |
| Semántica fría | 8 embeddings sintéticos | 42,84 | 1,24 |
| Semántica caliente | 1 embedding sintético | 42,59 | 1,61 |

El proceso abortó antes de emitir p50/máximo del benchmark principal: no se reconstruyen esos valores ni se reejecuta para obtenerlos.

| Situaciones 4.0: servicio + lector en memoria | Registros generados | Situaciones devueltas | p50 | p95 | Máximo | Bloqueo |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 1× | 484 | 11 | 4,15 | 5,91 | 7,42 | 5,10 |
| 10× | 4.840 | 30 | 42,18 | 50,37 | 51,84 | 50,94 |
| 100× | 48.400 | 30 | 424,67 | 455,12 | 456,30 | 459,59 |

Los volúmenes son el conjunto generado, no el número de señales elegibles: el lector filtra módulos y el motor aplica fechas/ventanas. La cifra de situaciones es la salida observada, no cobertura de todas las clases de datos.
Situaciones excede el umbral existente de 50 ms de bloqueo a 10× (marginalmente) y 100×; todos sus p95 quedan bajo 500 ms. Es un candidato medido para perfilado, no autorización para añadir otra tecnología ni prueba de latencia de producción. A 100× también exceden bloqueo IRSA, integrado, consenso y clasificación por lotes. No se atribuye regresión: hardware y versión difieren del benchmark histórico.

#### Reproducción de la medición adicional (sin artefactos de implementación)

```bash
cd apps/api && env -i PATH="$PATH" HOME="$HOME" LANG=C.UTF-8 node --input-type=module <<'NODE'
import { syntheticRecords, totalRecords } from './bench/synthetic.ts';
import { measure, table } from './bench/harness.ts';
import { createSituationsService } from './src/contexts/situations/application/index.ts';
const rows = [];
const scope = { companyId: 'SIPGES', projectId: 'PRJ-SECHURA' };
for (const scale of [1, 10, 100]) {
  const generated = syntheticRecords(scale);
  const all = Object.entries(generated).flatMap(([module, payloads]) =>
    payloads.map((payload, i) => ({ module, id: `${module}-${i}`, payload })),
  );
  const service = createSituationsService({
    settings: {
      load: async () => ({ version4: true }),
      save: async () => { throw Error('Read-only measurement'); },
    },
    records: { read: async (_tenant, modules) => all.filter(r => modules.includes(r.module)) },
    clock: { now: () => new Date('2026-10-13T12:00:00Z') },
  });
  const result = await service.situations(scope);
  if (!result.situations.length) throw Error('No situations: invalid measurement fixture');
  console.log({ scale, totalRecords: totalRecords(generated), situations: result.situations.length });
  rows.push(await measure('Situaciones 4.0 service+in-memory-reader', `${scale}x`, () => service.situations(scope)));
}
console.log(table(rows));
NODE
```

### Resultado y prioridad propuesta tras S5

1. Resolver el contexto del runner Vitest: el gate no acredita toda la API ni las pruebas posteriores. El diagnóstico y su reparación requieren una unidad separada; no inferir que las 57 suites sean 57 defectos.
2. Revisar el recorrido de autenticación/autorización del harness HTTP que recibe 403; no relajar permisos del producto. Sin esto faltan latencias HTTP/SQL, p50 y máximos del benchmark principal.
3. Perfilar Situaciones por el bloqueo medido a 10×, incorporando luego datos sintéticos representativos de lecciones/buzón y almacenamiento. No aplicar caché o workers sin identificar el coste y preservar resultados.
4. Mantener los 93 recorridos de navegador como evidencia de integración local, no como aceptación de producción. Conservar omisiones, timeouts históricos y límites externos.

No se cerraron los pendientes de otros ODD ni se retiró el control 4.0. No se realizaron correcciones P5.

### P2–P3: comprobaciones locales

- UI: `cd apps/web && env -i PATH="$PATH" HOME="$HOME" LANG=C.UTF-8 ../../node_modules/.bin/vitest run src/app/navigation.test.ts src/features/situations/SituationsPage.test.tsx src/features/situations/SettingsPage.test.tsx` — salida 0, 3 archivos y 19 pruebas aprobados (job-2).
- Build: `cd apps/web && env -i PATH="$PATH" HOME="$HOME" LANG=C.UTF-8 ../../node_modules/.bin/vite build` — salida 0, 29,33 s de build (job-3). Advertencia de chunks superiores a 500 kB: index 517,08 kB / 160,17 kB gzip; GeoCanvas 1.795,26 kB / 489,95 kB gzip; CesiumCanvas 3.766,75 kB / 996,98 kB gzip. Tamaño de fragmentos no equivale a latencia de interacción ni demuestra que se descarguen todos al inicio.
- API: `cd apps/api && env -i PATH="$PATH" HOME="$HOME" LANG=C.UTF-8 ../../node_modules/.bin/vitest run test/intelligence/narrative-evaluation.test.ts test/intelligence/operations-http.test.ts test/intelligence/situation-room-http.test.ts` — salida 1 (job-1), 20/22 aprobadas y 2 fallidas por timeout de 20.000 ms; 1 archivo aprobado y 2 fallidos. Fallos: `operations-http.test.ts:72` (clasificación con rol consulta) y `situation-room-http.test.ts:51` (ignorar bloqueos en 3.0). Duración Vitest 157,91 s. Sin reintentos ni modificación de límites. Causa no determinada; no se presume defecto funcional ni problema del entorno. UI/build se solaparon parcialmente con API: no se estableció causalidad.
- E2E: `cd apps/e2e && env -i PATH="$PATH" HOME="$HOME" LANG=C.UTF-8 ./node_modules/.bin/playwright test tests/18-territorial-intelligence.spec.ts tests/19-sipges.spec.ts tests/14-roles.spec.ts --project=chromium` — salida 1 (job-4), 5/6 aprobadas en 3,3 min. Aprobaron coordinador, consulta, narrativa → señal/bandeja en escritorio y viewport teléfono, y Situaciones → alerta humana. Falló el recorrido de todas las pantallas del analista por timeout global de 60.000 ms mientras estaba en `/fuentes` (`14-roles.spec.ts:44`); cierre de sesión de protocolo al finalizar. La salida no demuestra denegación de permisos ni defecto de `/fuentes`: la causa no está establecida. Adjuntos locales bajo `apps/e2e/test-results/14-roles-analista-every-screen-opens-without-errors-chromium/` (captura, contexto, trace). No se reintenta. Entorno limpio, sin URLs heredadas ni PostgreSQL real.
- En la etapa inicial P4 no se lanzó tras el fallo API. S5 autorizó posteriormente la ejecución completa: sus resultados y bloqueos se conservan arriba. En aquella etapa T5/T6 seguían sin completarse; no se transforma la evidencia parcial en aprobación. Los cierres posteriores por componentes de T5 y benchmark local de T6 figuran en sus secciones propias.

## Decisiones y bloqueos

| Tema | Estado | Próxima decisión o evidencia |
| --- | --- | --- |
| Alcance actual | Auditoría y medición sintética P1–P4 autorizadas | Sin correcciones de comportamiento ni activación externa |
| Ejecutar P1–P4 | Autorizado por S4 | Registrar comprobaciones y limitaciones; no implica aprobar P5 |
| Unificar la presentación 3.0/4.0 | Recomendación, no decisión de producto | Definir experiencia y compatibilidad después del inventario; conservar controles justificados |
| Redundancia y lentitud actuales | Hipótesis | Reproducción de recorridos y baseline; no declararlas como defectos confirmados |
| GEOCATMIN y push real | Evidencia externa pendiente en ODD propietario | Acceso/disponibilidad y confirmación del dispositivo; no sustituirlos por adaptadores de prueba |
| Fuentes originales y metodología | Dependencia humana | Documentos, aceptación y validación del responsable; no inferir ni completar datos para aparentar cobertura |

## Log

- L1 — Petición original literal (el usuario la envió dos veces, la segunda con saltos de línea): «hey bro que mas falta para mascli ?? , he visto que mascli tiene un modulo de mascli 4.0 , se activa y mas , no deberia estar todo actualizado , conectado , y en la vanguardia ?? , eliminar redundancia , friccion , mejorar performance y mas ??».
- L2 — Seguimiento literal: «yes ODD de integracion».
- L3 — El usuario seleccionó «Diagnóstico y plan ODD primero (recomendado)», con la descripción citada en S3. No autorizó implementación.
- L4 — Exploración de solo lectura: composición y controles, ODD existentes, distinción entre agrupación de situaciones y vecindario tipado, y límites de evidencia de pruebas/despliegue. Spot check del padre: el servicio de Situaciones lee módulos y lecciones antes del cálculo; eso justifica medir, no afirmar lentitud. No se ejecutaron pruebas funcionales ni se accedió a datos reales.
- L5 — Estado inicial preservado: docs/agents/gentle-ai.md modificado y .pi/ sin seguimiento; no pertenecen a este entregable. Sin commits, publicaciones ni activaciones. El pnpm odd:status de la revisión anterior preparó dependencias automáticamente; las comprobaciones de este documento usarán directamente Node y binarios locales.
- L6 — Verificación documental inicial: Prettier aprobado; 22 enlaces locales existentes; secciones Specs/Tasks/Log presentes y Log al final; odd:status --json y git diff --check con salida 0. No se ejecutaron pruebas funcionales, benchmarks ni consultas remotas en esa etapa. Espejo de continuidad: odd/integration-consolidation/tasks en Engram.
- L7 — Autorización literal posterior: «yes te autorizo and continue». Se habilita auditoría P1–P4 con datos sintéticos; P5, despliegues, activaciones externas y datos reales siguen excluidos. Checkout reconciliado: b2ad4f9 en main; cambios preexistentes preservados.
- L8 — T4: mapa de capacidades y requisitos reconciliado; pruebas API/UI focalizadas lanzadas con entorno limpio (sin URLs heredadas). E2E/build y benchmark dependen de sus requisitos locales. Ninguna activación ni lectura remota. No se atribuye al motor Situaciones la cobertura del benchmark «Situational analysis».
- L9 — UI focalizada: 19/19 en 3 archivos, salida 0. Build web salida 0 con advertencia de tamaño de chunks; se conservan cifras sin atribuir una regresión. Lanzada E2E 14/18/19 Chromium con PGlite temporal y entorno limpio.
- L10 — API job-1 terminó con salida 1: 20 aprobadas, 2 timeouts de 20 s (clasificación consulta y bloqueos 3.0), causa no determinada. No se reintenta ni se elevan límites. T5 no completada; T6 no lanzada.
- L11 — E2E job-4 terminó con salida 1: 5 aprobadas y 1 timeout global 60 s del recorrido analista en /fuentes. Los recorridos de narrativa → señal/bandeja (escritorio y viewport teléfono), Situaciones → alerta humana, coordinador y consulta aprobaron. Sin reintentos ni diagnóstico causal inventado. T7 cerró únicamente el informe parcial; T5/T6 quedaron bloqueadas. No se ejecutó benchmark ni se declaró integración completa.
- L12 — Petición literal: «aceto el informe , pero avanza con la verificacion completa y las mediciones». Autoriza una nueva ejecución completa, no un reintento automático de las pruebas focalizadas. T5/T6 reanudadas y T7 reabierta. Se ejecutarán secuencialmente gate existente, navegador completo y benchmark completo, con códigos de salida separados y entorno limpio. PostgreSQL real sigue omitido por falta de conexión sintética explícita; P5 sigue excluida.
- L13 — Gate job-5 salida 1: estáticos/tipos aprobados, soporte E2E 10/10 y kernel 8/8; API 313 aprobadas/3 omitidas, 57 suites fallan en carga por contexto Vitest (no timeouts anteriores). Paquetes posteriores no ejecutados. Lanzada suite navegador completa job-6, sin reintentar gate ni reparar dependencias. Se mantiene la continuación explícita de S5 hacia mediciones.
- L14 — Navegador completo job-6 salida 0: 93 aprobadas y 1 captura opcional omitida, 8,3 min. La ejecución serial pasó también los recorridos de roles sin borrar el timeout histórico. Lanzado benchmark completo job-7; T5 sigue sin aprobar por fallo del gate.
- L15 — Benchmark job-7 salida 1: métricas de motores/documentos/semántica conservadas; HTTP abortó en /api/dashboard403 tras login200. Job-8 Situaciones servicio/memoria salida 0: p95 5,91/50,37/455,12 ms a 1×/10×/100×; bloqueo 5,10/50,94/459,59 ms. Sin SQL/HTTP/lecciones/buzón en esa medición. Se registra reproducción sin modificar el harness. T6 no completa por baseline HTTP ausente; T5 no completa por gate fallido. T7 documentó resultado parcial.
- L16 — El usuario pidió «perfect , continue» y seleccionó «Sí, completar T5 (recomendado)» con la descripción literal S6. Se autoriza corrección del runner y gate serial, no T6. Rama creada fix/t5-vitest-context desde b2ad4f9; se preservan cambios preexistentes. Resolución local muestra Vitest 5.0.4 en raíz y apps pero con dos identidades físicas de peer-dependencies distintas.
- L17 — Worker acotado confirmó RED/GREEN quitar/restaurar dedupe, 36/36 de configuración, tooling1/1 y lifecycle5/5. Padre leyó diff y documentación; no hay cambios de dependencias/timeouts/hooks/permisos. Añadidas comprobaciones de cierre del último clon. Gate serial job-9 lanzado. ASSESS escalado item5 exige verificación independiente; revisión nativa aún no ejecutada ni aprobada.
- L18 — Petición literal: «termina T5». Reconciliación de incidente: mismo checkout/rama y cambios conservados, pero job_list no contiene trabajos y el log del job-9 devuelve ENOENT. Su resultado permanece desconocido. No fue un timeout observado ni se declara aprobado. Se inicia nuevo gate serial autorizado con log/código persistentes dentro del proyecto; no se repiten checks de navegador ni se toca T6.
- L19 — Verificador independiente mvm6znlt-1-xwfr leyó documento completo, diff y fixtures: sin hallazgos estáticos graves; confirma que dedupe no retira limpieza ni amplía límites. No ejecutó pruebas para no solaparlas con el gate. Observaciones no bloqueantes: recuento/reporter fijo, lanzador POSIX y posible diagnóstico secundario si primer setup falla. Su dictamen cubre candidato API, no cambios posteriores.
- L20 — Autorización literal: «yes te autorizo todo y avanza de forma auotnoma», en contexto de finalizar T5. Gate persistente terminó salida1: API691 aprobadas/14omitidas; web65suites fallan al cargar runner, no resultados funcionales. Monitor detenido al terminar gate. Se conserva log/código; continuación acotada del worker mvm7845g-2-zkej para runner web y regresión, sin dependencias/timeouts/skips/permisos ni T6. No se reintenta gate sin un cambio justificado.
- L21 — Worker confirmó web RED1archivo/cero pruebas → GREEN6/6 con dedupe; regresión tooling web1/1, stdout aprobado/stderr vacío. Padre leyó diff y comprobó whitespace. Verificador independiente mvm7bmv7-3-p273 recibe candidato API/web para ejecutar regresiones acotadas en serie y comprobar si hosting presenta bloqueo de carga; no hay gate simultáneo.
- L22 — Verificador independiente: regresiones públicas API/web2/2 (4,56 s) y hosting4archivos/11pruebas (2,69 s), salidas0; sin hallazgos bloqueantes y sin cambiar repositorio. Hosting solo advertencia Node localStorage, sin error de contexto. Comprobaciones en copia aislada sin .git/data/.pi/.env; retuvo temporal /tmp/mascli-t5-verifier.jMfXwU, no eliminado por el padre al quedar fuera del proyecto. Lanzado gate final serial API+web con evidencia nueva.
- L23 — Gate final job-3 salida1,11min18s: API691 aprobadas/14omitidas y web276 aprobadas/7fallidas. Web ya carga65suites: fallo de contexto corregido, no gate aprobado. Seis timeouts5s y una expectativa asíncrona push; causas no determinadas. Hosting/tooling del gate no ejecutados; evidencia independiente previa se conserva sin sustituir el gate. T7 cerró solo el informe parcial; no se hizo commit/publicación.
- L24 — Autorización literal «yes autorizo todo y ve de forma autonoma» para la unidad de diagnóstico/corrección de siete fallos web propuesta en S7. T5 reanudada, T7 reabierta. Se preservan límites/expectativas y se evita repetir API si no cambia. No autoriza cambios de producto ajenos a estos fallos, T6, datos reales ni activaciones.
- L25 — Worker mvm7y88v-4-16mb reprodujo carrera push con respuesta retenida y corrigió espera del mismo texto final. Probe7archivos originales48/48 tanto default como serial: seis timeouts no reproducidos, causa no demostrada. Configura1worker/sinparalelismo entre archivos sin cambiar límites/hooks. GREEN7archivos48/48. Padre revisó diff.
- L26 — Fullweb serial job-4 salida0:65archivos283pruebas aprobados,129,51s. Lanzado job-5 para lint/límites/tipos/buildweb/hosting/tooling en serie, sin repetirAPI691/14 ni navegador93/1 por no cambiar sus fuentes/configuración. Se conserva el gate monolítico fallido anterior y no se lo reetiqueta como aprobado.
- L27 — Job-5 salida1 por formato de DevicePush.test.tsx en Prettier; pruebas no reejecutadas ni invalidadas por ese resultado. Se aplicó Prettier únicamente a ese archivo, sin cambio lógico; diffcheck0. Comprobaciones restantes reanudadas como job-6 con log/código nuevos `remaining-checks-formatted`, preservando el fallo de formato. No se repiteAPI ni fullweb.
- L28 — Job-6 salida0: lint/formato/límites/tipos/buildweb/hosting11/tooling9 aprobados. Independent verifier mvm8bpxj-5-okbp confirmó logs y seguridad estática S7, sin hallazgos graves; no ejecutó el comando focalizado por conflicto entre instrucción paterna de workspace y su requisito de copia aislada. No se inventa resultado. Inspección de autoridad no creó lineage; ASSESS aún unassessable por declaración de untracked. No se inicia revisión que incluya el cambio ajeno docs/agents/gentle-ai.md.
- L29 — Se intentó resolver la restricción de ubicación permitiendo copia dentro del proyecto. El verificador informó que sus instrucciones superiores exigen temporal del sistema y copia de dependencias; no ejecutó comando ni creó scratch. No se insiste ni se inventa resultado. El padre ejecutó DevicePush en el proyecto, salida0/3aprobadas (1,55s), guardado `push-final.log`/`.exit`. Es una ejecución del padre, no independiente. Revisión independiente estática y logs sin hallazgos graves.
- L30 — Código/tests/documentación de runners guardados en commit propio6299b81 (7archivos/156líneas). API/web/configuración de producto no alterados después de las verificaciones correspondientes. T5 cerrada funcionalmente por pruebas acumuladas; ASSESS committed-only sigue unassessable por untracked, sin reviewDue/lineage/aprobación nativa, limitación explícita. T6 sigue bloqueada403fueraalcance. No publicación ni cambios ajenos.
- L31 — Resumen de sesión guardado y pnpm engram sync salida0: chunk e900d588,83observaciones,0prompts. Se revisaron inventario y patrones de secretos, sin coincidencias detectadas; no se comparten credenciales ni datos de aplicación. README de evidencia resume aprobaciones/omisiones y logs locales. Cierre documental b811d8b posterior a6299b81, excluyendo rawlogs, .pi/ y cambio ajeno docs/agents/gentle-ai.md.
- L32 — Petición literal «continue», después del cierre T5 y siguiente paso explícito T6. Se autoriza diagnóstico/corrección del 403 del harness y medición sintética; no tocar guardas/permisos ni usar BD real. Rama fix/t6-synthetic-http-benchmark desde b811d8b: frontera de revisión T6 es b811d8b, separada de los slices T5 6299b81 y b811d8b. Estado y cambios ajenos/logs conservados; no repetir suites T5 sin cambio compartido.
- L33 — Worker mvm8vs9w-7-tsgh reprodujo mfa_required403/login200 y entregó fixture compartido que inscribe MFA/selecciona proyecto mediante endpoints públicos. RED1fallo5,62s/GREEN1aprobada5,09s; no guardasmod. Padre revisó diff y lanzó fullbenchmark serial job7salida0/43s/36mediciones; se guardan full.json/stdout/stderr/exit. LocalStoragewarning retenida.
- L34 — Diferencial job8salida0/23s: b811d8b --quick --out aborta403/salida1/sinJSON, actualsalida0/JSON29incluye7HTTPa5runs;22etiquetas/orden previos iguales. No otros comandos comparten fixture nuevo. Scratchbase creado y retirado dentro del proyecto; no se leen secretos/datos reales. Medición PGlite app.request, no SQLservidor aislado.
- L35 — Checks job9salida1: lint/formato/bounds735/2169aprobados; TS2322enhttp-session45 impide tests. Padre valida JSONunknown con guardobject/secretstring sin cast, no cambia setup exitoso/GETtiming. Checks-fixed job10types/lint/formatoaprobados; rootVitest aprueba nueva1pero dashboardnocarga porcontexto. Con lanzador local correcto job11dashboard3aprobadas,nueva0testfailed porcontexto. Se conservan fallos distintos; no se declara suiteaprobada ni T6completa. Continuación worker mvm9e45k-9-b0us acotada a nueva regresión/fixture, sin tocar T5config/deps.
- L36 — Verificador mvm97en1-8-xqxo leyó documento completo, diff y logs: S4/S5/S8medición cumplidos en unidadT6, sinsevere; revisión estática+evidencia del padre, no ejecución funcional independiente. Revisó fixture antes del estrechamiento JSONtypes; no inventar revisión posterior. No adoptar sugerencia opcional de inspeccionar SQLinterno para aserciones: se mantiene verificación pública de totales, sin afirmar igualdad byte a byte de todo almacenamiento. ASSESSunassessableuntracked, sin aprobación/lineage nativa; riesgo2 por preparación MFA sintética.
- L37 — Continuación worker mvm9e45k-9-b0us: REDdiagnóstico local1/8,48s y GREEN0/13,48s con --no-fs-module-cache,2archivos/4pruebas,fuentes/configuración sin cambios. Causa: transforms guardados importaban peer raíz3599de6, runner localc1d55baa; padre spotcheckcachelínea2 confirma importabsoluto. Solo documentó comando; no borró caché/no configuración ni dependencias cambiadas. Evidencia del worker combinada conservada como handoff atribuido, no streams separados inventados. T6 cerrada: benchmarklocal/36 ycomparativa/29 válidos, presupuestobloqueoexcedido y cachedrunfallido explícitos. T7 actualiza docs/evidencia/memoria y slices; sin publicar.
- L38 — Unidad T6 guardada en3289896:10archivos,696inserciones/48borrados,338líneasJSONgeneradas y406líneas restantes incluyendo metadatos de memoria (aproximadamente400). Fuente+regresión+documentación+baseline juntos, sin cambios ajenos ni rawlogs. ExportEngram9d869ff9:6observaciones,0prompts; inventario/patrones de secretos revisados sin coincidencias detectadas. Fronteras de revisión por unidades, nunca rama acumulada: T5código b2ad4f9→6299b81; T5docs6299b81→b811d8b; T6fixture b811d8b→3289896; siguiente slice solo cierre documental desde3289896. Aviso automático1209líneas acumuladas desdeorigin/main no convierte el conjunto en candidato único; si se publica, conservar cadena de unidades. No se crea PR ni se publica. Revertir3289896 retira fixture/regresión/nueva evidencia local y su export, no guardas de producto ni datos reales.
- L39 — T7 cerrada sobre evidencia versionada3289896 y b811d8b; estructura/enlaces/JSON/diffcheck aprobados, resumen12833 y sync previos guardados. Se conserva baseline limitado y todos los fallos, sin reclamar gate monolítico/cached0, SQLservidor ni aprobación nativa. Cierre manual acotado: odd:close espera logs con formato «- L<n> (» y este documento preserva «- L<n> —», no se cambia el script ni logs históricos. Reconciliar odd:status a7/7 y guardar espejo/resumen/export final antes del commit de metadatos; no autoriza activar P5, servicios ni producción.
