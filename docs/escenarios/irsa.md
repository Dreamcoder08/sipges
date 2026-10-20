# Escenarios del IRSA

Cada fila da el puntaje (0 a 100) de las seis dimensiones del IRSA y el semáforo que el equipo
espera con la configuración por defecto (pesos iguales; Verde hasta 24,99, Amarillo hasta 49,99,
Naranja hasta 74,99, Rojo desde 75). Antes de cambiar pesos o umbrales, añade aquí el caso que
debe cumplirse; `pnpm verify` ejecuta esta tabla. Los pesos y umbrales siguen pendientes de
validación metodológica.

Dimensiones: **G** Gobernanza y representación, **A** Actores e influencia, **D** Demandas y
compromisos, **N** Narrativas y señales digitales, **E** Ambiental-territorial, **I**
Institucional y trazabilidad.

| Caso | G | A | D | N | E | I | Semáforo |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Territorio estable | 10 | 10 | 15 | 5 | 10 | 10 | Verde |
| Demandas abiertas sin respuesta | 30 | 30 | 60 | 30 | 20 | 30 | Amarillo |
| Conflicto por agua en escalada | 60 | 55 | 70 | 65 | 90 | 40 | Naranja |
| Crisis en todas las dimensiones | 80 | 75 | 85 | 80 | 90 | 70 | Rojo |
