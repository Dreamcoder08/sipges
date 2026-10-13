# MASCLI · Gestión Territorial Empresarial

MASCLI es un prototipo web para registrar eventos, actores, demandas, compromisos y evidencias, y apoyar el análisis territorial del Proyecto Sechura. La aplicación actual se identifica como **3.0.0-rc**; el motor analítico sigue en calibración técnica y pendiente de validación externa.

## Documentación visual con Archify

- [Mapa interactivo de arquitectura](docs/diagrams/arquitectura.html): interfaz, acceso por empresa/proyecto, API, datos, configuración y evidencias.
- [Guía de arquitectura y regeneración](docs/ARQUITECTURA.md).
- [Fuente editable del mapa](docs/diagrams/arquitectura.json).

Descarga el HTML y ábrelo en el navegador. GitHub muestra su código y no ejecuta el visor. El archivo contiene el visor y el diagrama; los enlaces a las fuentes requieren conexión y acceso al repositorio. Selecciona un componente para consultar sus referencias de código. El visor permite explorar relaciones, cambiar el tema y exportar imágenes.

[![Vista previa del mapa de arquitectura MASCLI](docs/diagrams/arquitectura.png)](docs/diagrams/arquitectura.html)

## Inicio local

Requiere Python 3.10 o posterior, según la sintaxis del código. Desde la raíz del repositorio:

```bash
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
export MASCLI_ADMIN_USERNAME=admin
read -rs -p 'Contraseña inicial (mínimo 12 caracteres): ' MASCLI_ADMIN_PASSWORD
export MASCLI_ADMIN_PASSWORD
python -m uvicorn app:app --host 127.0.0.1 --port 8000
```

Abre <http://127.0.0.1:8000>. La contraseña de entorno sirve para inicializar la cuenta cuando no existen usuarios; no sustituye la contraseña de una cuenta ya creada. Para PowerShell, consulta [el inicio RC 3.0](README_RC_3_0_INICIO.txt).

## Referencias del proyecto

| Documento | Contenido |
| --- | --- |
| [Novedades RC 3.0](NOVEDADES_RC_3_0.md) | Alcances por empresa/proyecto, TOTP y limitaciones del piloto |
| [Especificación IRSA](IRSA_ESPECIFICACION_TECNICA.txt) | Metodología del índice |
| [Estado de calibración](README.txt) | Condiciones para declarar validación científica |
| [Módulo situacional](NUEVO_MODULO_ANALISIS_SITUACIONAL.txt) | Análisis e informes |
| [Despliegue en Render](README_RENDER.txt) | Instrucciones históricas de despliegue |

Los documentos de versiones anteriores se conservan como historial. Para el comportamiento actual, usa RC 3.0 y el código enlazado desde el mapa. RC 3.0 sigue siendo un piloto técnico; sus análisis no equivalen a hechos corroborados ni a un modelo científicamente validado.
