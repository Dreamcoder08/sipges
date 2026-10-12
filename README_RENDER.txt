MASCLI – PROYECTO SECHURA
VERSIÓN LISTA PARA PUBLICAR EN RENDER

1. Cree un repositorio nuevo en GitHub.
2. Suba TODOS los archivos de esta carpeta a la raíz del repositorio.
3. Ingrese a Render y elija New > Blueprint.
4. Conecte el repositorio de GitHub.
5. Render detectará render.yaml.
6. Confirme el servicio y espere el despliegue.
7. Render generará una URL pública, por ejemplo:
   https://mascli-proyecto-sechura.onrender.com

Configuración incluida:
- Python 3.12.8
- FastAPI + Uvicorn
- Health check /health
- Comando de inicio compatible con Render
- Base SQLite temporal en /tmp/mascli.db

IMPORTANTE SOBRE LOS DATOS:
En el plan gratuito de Render, el almacenamiento local es efímero. La Base Maestra se vuelve a cargar desde data/seed.json cuando se recrea el servicio. Para una versión productiva con persistencia real, se recomienda PostgreSQL o un disco persistente.

ESTADO ACADÉMICO:
MASCLI Web Final RC 1.0 / Motor V0.5.1. La interfaz es final para demostración, pero la validación externa del modelo sigue pendiente.
