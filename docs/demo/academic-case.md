# Caso académico sintético

Este caso simula tres situaciones de relacionamiento territorial en `MASCLI/PRJ-SECHURA`: capacitación y empleo local con acuerdo cumplido; monitoreo participativo del agua con negociación abierta; tránsito y ruido con un compromiso atrasado. La fecha de corte del ejercicio es 2026-10-14. Los hechos, organizaciones, personas y mediciones son inventados. Los estados de verificación también son simulados; no se presentan como evidencia real ni validación científica del IRSA.

## Contenido

| Módulo | Registros |
| --- | ---: |
| Actores | 12 |
| Directorio territorial | 12 |
| Eventos | 20 |
| Fuentes | 10 |
| Demandas | 12 |
| Compromisos | 12 |
| Narrativas | 8 |
| Alertas territoriales | 6 |
| Acciones territoriales | 8 |
| Intereses | 6 |
| Diálogos | 4 |
| Oportunidades | 4 |
| Hechos compartidos | 4 |
| AARC | 4 |
| **Total** | **122** |

Se preparan diez evidencias reales de formato: un PDF, un DOCX y ocho TXT, todos pequeños y con contenido sintético. Las referencias de actor/fuente/demanda/alerta apuntan a claves del mismo conjunto. No se crean usuarios ni roles, no se añaden números telefónicos y los correos/enlaces usan el dominio reservado `example.invalid`. Sechura solo aporta contexto geográfico al ejercicio; las organizaciones llevan la marca `[SINTÉTICO]` y no describen entidades locales reales.

Los indicadores se calculan a partir de los registros por los casos de uso existentes. No se fijan resultados, pesos ni puntuaciones para fabricar una conclusión. `Vencido` permite representar el atraso reconocido por el modelo; el editor conserva ese estado importado. El directorio deja los teléfonos vacíos deliberadamente, por lo que algunos factores de trazabilidad pueden mostrar información incompleta.

## Reproducción por API

La implementación TypeScript está en `apps/api/src/tools/academic-demo/`. Exportar un manifiesto no requiere credenciales ni contacta la aplicación:

```bash
node apps/api/src/tools/academic-demo/cli.ts --export /tmp/mascli-academic-v1.json
```

La ruta de exportación debe ser nueva: no se sobrescribe un archivo existente. Para cargar, un administrador autorizado configura privadamente `MASCLI_DEMO_URL`, `MASCLI_DEMO_USERNAME` y `MASCLI_DEMO_PASSWORD`; `MASCLI_DEMO_OTP` es opcional si su cuenta tiene TOTP. Nunca poner valores en comandos, PR, logs o documentación. La URL debe ser HTTPS salvo localhost, y sin credenciales ni rutas. En Node 24.5+ con un proxy HTTP del entorno, `NODE_USE_ENV_PROXY=1` usa ese proxy sin cambiar sus reglas.

```bash
# Por defecto solo planifica; no crea registros ni archivos.
pnpm --filter @mascli/api demo:seed

# Añade registros y evidencias al proyecto sintético previsto.
pnpm --filter @mascli/api demo:seed -- --apply
```

El proyecto se verifica mediante `/system/auth/current-scope`; cada petición lleva el alcance explícito `MASCLI/PRJ-SECHURA`. El importador usa autenticación, autorización, validación, auditoría y almacenamiento de la API normal, sin leer bases legacy ni conectarse directamente a PostgreSQL. La sesión de carga se revoca al terminar.

Solo se añaden elementos faltantes. `Demo_Dataset`, `Demo_ID` y `Dato_Sintetico` permiten repetir una carga parcial; registros existentes y ediciones de usuarios no se reemplazan. Se rechazan marcadores duplicados, colisiones de ID y listados que alcanzan el límite de 500, porque no se puede garantizar que sean completos. Las evidencias existentes se conservan por su registro, nombre y marcador de procedencia. No ejecutar importadores simultáneos sobre el mismo proyecto: la API de creación genérica no ofrece una reserva de IDs para este proceso.

La carga de registros y archivos no es una sola transacción: si falla a mitad, queda una carga parcial, que puede retomarse. No hay borrado automático ni restablecimiento del proyecto. Las alertas de inteligencia y planes preventivos son flujos distintos de los registros genéricos; requieren revisión humana y se trabajan desde sus pantallas, no se marcan como verificados por el importador.

## Recorrido de evaluación

1. Dashboard: revisar eventos, actores, demandas abiertas y alertas activas.
2. Actores y fuentes: seguir referencias y descargar evidencias.
3. Demandas/compromisos: contrastar el cierre documentado, la negociación y el atraso.
4. IRSA: revisar los factores, evidencia y limitaciones; guardar una instantánea.
5. Análisis situacional, estratégico e integrado: revisar la lectura del caso y descargar DOCX.
6. Laboratorio documental: analizar el PDF o DOCX sintético y contrastarlo con un TXT.
7. Consensos/AARC: comparar preocupaciones, opciones, hechos por verificar y próximos pasos.

Las pruebas comprueban integridad de referencias, importación por HTTP real sobre una base temporal sintética, idempotencia de registros/evidencias, límites de listados, PDF legible y DOCX real. La comprobación de la URL pública debe registrarse por separado: pruebas locales aprobadas no significan que la carga pública ya se completó.

## Comprobación pública del 2026-10-14

Se cargaron 122 registros y diez evidencias en la demo mediante la API. La segunda carga creó cero elementos: omitió los 122 registros y los diez archivos existentes. Chromium comprobó las 14 colecciones, contadores del dashboard, SHA-256 de las diez descargas Blob, cálculo IRSA y corte inicial, cuatro reportes DOCX válidos, lectura PDF/DOCX y comparación documental; pantallas pobladas y vista móvil sin errores de página. El [recibo](public-verification.json) contiene resultados y conteos, sin identidades ni credenciales.

IRSA sobre este caso ficticio: 26.14, Amarillo. Es una salida de las reglas provisionales sobre datos sintéticos, no una medición de riesgo real ni validación científica. Se conservan cuestiones pendientes en el escenario: algunas alertas carecen de responsable efectivo y no hay actores priorizados; esos ceros y avisos son tareas que el evaluador puede trabajar.

La suite local aprobó API 465/7 PostgreSQL opcionales omitidas, web102, kernel3, limpieza3, hosting6 y herramientas4. CI del código `c1bec2a` aprobada con PostgreSQL real y 29 E2E, ejecución38503196268. No se modificaron pesos de indicadores, cuentas o datos reales.
