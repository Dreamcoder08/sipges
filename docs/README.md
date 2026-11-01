# Documentación de SIPGES

Un índice, una línea por página: qué pregunta responde cada una. Las guías viven en esta carpeta; los planes de trabajo, en [`odd/tasks`](../odd/tasks).

## Inicio

| Página                                                                                   | Responde                                                                                          |
| ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| [overview.md](overview.md)                                                               | ¿Qué stack usa SIPGES, qué módulos existen y cómo arranco en local?                               |
| [migration/workspace.md](migration/workspace.md)                                         | ¿Qué comandos, variables de entorno y pruebas de base de datos tiene el workspace?                |
| [escenarios/irsa.md](escenarios/irsa.md), [escenarios/alertas.md](escenarios/alertas.md) | ¿Qué puntajes del IRSA y qué prioridades de alertas espera el equipo? (los ejecuta `pnpm verify`) |

## Arquitectura y decisiones

| Página                                                                             | Responde                                                                |
| ---------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| [ARQUITECTURA.md](ARQUITECTURA.md)                                                 | ¿Cómo está compuesto el sistema y cómo regenero el mapa Archify?        |
| [adr/README.md](adr/README.md)                                                     | ¿Qué decisiones de arquitectura se tomaron y por qué?                   |
| [architecture/architecture-guardrails.md](architecture/architecture-guardrails.md) | ¿Qué reglas de dependencia y abstracción se respetan?                   |
| [architecture/ui-components.md](architecture/ui-components.md)                     | ¿Cómo se componen y de dónde vienen los componentes de interfaz?        |
| [migration/tenancy.md](migration/tenancy.md)                                       | ¿Cómo se separan la administración global y las operaciones por tenant? |
| [secure-cookies.md](secure-cookies.md)                                             | ¿Cómo se configuran las cookies seguras de sesión y proyecto?           |
| [design/mobile-first/](design/mobile-first/)                                       | ¿Cómo se veía la interfaz antes y después del rediseño mobile-first?    |

## Módulos de la API y la web

| Página                                                                 | Responde                                                                       |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| [migration/behavior-contract.md](migration/behavior-contract.md)       | ¿Qué comportamiento del prototipo Python debe conservar la versión TypeScript? |
| [migration/records.md](migration/records.md)                           | ¿Cómo funcionan los registros territoriales y la auditoría?                    |
| [migration/evidence.md](migration/evidence.md)                         | ¿Cómo se suben, listan y descargan las evidencias?                             |
| [migration/documents.md](migration/documents.md)                       | ¿Cómo se leen documentos y se generan los informes DOCX?                       |
| [migration/indicators-analytics.md](migration/indicators-analytics.md) | ¿Cómo se calculan los indicadores, el IRSA y la analítica estratégica?         |
| [migration/operations.md](migration/operations.md)                     | ¿Cómo funcionan la inteligencia digital, la prevención y el centro gerencial?  |
| [migration/web.md](migration/web.md)                                   | ¿Cómo está organizada la SPA y cómo se sirve?                                  |
| [integrations/README.md](integrations/README.md)                       | ¿Cómo configuro automatizaciones, canales de salida, claves de API y MCP?      |

## Operaciones y despliegue

| Página                                                                           | Responde                                                        |
| -------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| [deployment/readiness.md](deployment/readiness.md)                               | ¿Qué debo comprobar antes de publicar la API con la SPA?        |
| [deployment/cloudflare-workers.md](deployment/cloudflare-workers.md)             | ¿Cómo se publica con el adaptador de Cloudflare Workers?        |
| [deployment/territorial-intelligence.md](deployment/territorial-intelligence.md) | ¿Cómo se generan las señales y los avisos territoriales?        |
| [migration/data-migration.md](migration/data-migration.md)                       | ¿Cómo muevo una instalación legada RC 3.0 a PostgreSQL?         |
| [migration/base-maestra.md](migration/base-maestra.md)                           | ¿Cómo cargo la Base Maestra en una base vacía?                  |
| [benchmarks/README.md](benchmarks/README.md)                                     | ¿Qué umbrales de rendimiento justifican un adaptador Go o Rust? |

## Pruebas

| Página                   | Responde                                                            |
| ------------------------ | ------------------------------------------------------------------- |
| [testing.md](testing.md) | ¿Cómo verifico un cambio, enfoco una prueba y reporto el resultado? |

## Agentes

| Página                                     | Responde                                                        |
| ------------------------------------------ | --------------------------------------------------------------- |
| [agents/gentle-ai.md](agents/gentle-ai.md) | ¿Cómo se usan Gentle AI y Engram en el repositorio?             |
| [agents/skills.md](agents/skills.md)       | ¿Qué skills locales existen y qué evidencia justifica cada una? |

## Referencia y legado

| Página                                                         | Responde                                                       |
| -------------------------------------------------------------- | -------------------------------------------------------------- |
| [../reference/python/README.md](../reference/python/README.md) | ¿Cómo ejecuto la referencia Python congelada y sus lanzadores? |
| [../reference/python/docs/](../reference/python/docs/)         | ¿Qué especificaciones y correcciones documentó el prototipo?   |

## Historial

| Página                                                                                                                                                                               | Responde                                                                    |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------- |
| [history/python-prototype.md](history/python-prototype.md)                                                                                                                           | ¿Qué trajo cada versión del prototipo Python (RC 1.7 → 3.0, v0.4 → v0.5.1)? |
| [history/archify-verification.md](history/archify-verification.md)                                                                                                                   | ¿Qué gates pasó cada entrega del mapa Archify?                              |
| [history/t11-verification.md](history/t11-verification.md), [history/t11b-verification.md](history/t11b-verification.md), [history/t14-verification.md](history/t14-verification.md) | ¿Qué se comprobó en T11, T11b y T14?                                        |
| [history/main-consolidation.md](history/main-consolidation.md)                                                                                                                       | ¿Cómo se consolidó la cadena T8–T14 sobre `main`?                           |
| [history/public-demo-verification.md](history/public-demo-verification.md)                                                                                                           | ¿Qué se comprobó en la demo académica pública?                              |
| [history/agents-verification.md](history/agents-verification.md)                                                                                                                     | ¿Cómo se verificaron las skills y los scripts?                              |
| [history/data-quality-followup.md](history/data-quality-followup.md), [history/integral-functional-audit.md](history/integral-functional-audit.md)                                   | ¿Qué hallazgos dejaron la calidad de datos y la auditoría funcional?        |
