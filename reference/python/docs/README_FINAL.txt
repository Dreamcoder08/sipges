MASCLI – PÁGINA WEB FINAL DE TESIS
Proyecto Sechura · Piura · 2026

VERSIÓN
- Interfaz: Web Final RC 1.5
- Motor analítico: MASCLI V0.5.1 – Calibración Técnica
- Estado científico: validación externa pendiente

QUÉ INCLUYE
- Dashboard ejecutivo
- Eventos y análisis automático explicable
- Actores
- Demandas y compromisos
- Centro de alertas
- IRSA-MASCLI
- 32 indicadores G1–I6
- Validación experta
- Fuentes y evidencias
- Metodología del modelo
- Auditoría y trazabilidad
- Administración demostrativa de usuarios y roles (sin autenticación real)
- Directorio territorial de autoridades y líderes
- Narrativas y señales digitales
- Carga y descarga de evidencia (PDF, Office, CSV, TXT e imágenes; máximo 10 MB)
- Catálogo de proyectos, selector de proyecto activo y etiquetado Proyecto_ID/Proyecto
- Gráficos de alertas por nivel y eventos por dimensión para el proyecto activo
- Delimitación de las 5 concesiones Bayóvar del Proyecto Sechura, tabla de coordenadas y vértices WGS84
- Diseño responsive para PC, tablet y celular

INICIO EN WINDOWS
1. Tener Python instalado.
2. Ejecutar: INICIAR_MASCLI_FINAL.bat
3. Abrir en el navegador: http://127.0.0.1:8000

INICIO EN LINUX / MAC
1. Ejecutar: ./iniciar_mascli_final.sh
2. Abrir: http://127.0.0.1:8000

IMPORTANTE
La web está finalizada como prototipo de tesis. No debe rotularse como “modelo validado” hasta cerrar juicio de expertos, Gold Standard y métricas de validación funcional.

ALMACENAMIENTO DE ARCHIVOS
- Los adjuntos se guardan en data/uploads o en la ruta indicada por MASCLI_UPLOAD_DIR.
- En el plan gratuito de Render el disco local es efímero: los archivos pueden perderse al reiniciar o redesplegar. Para uso real configure almacenamiento persistente externo y autenticación/autorización.
- La gestión de usuarios y roles incluida es un prototipo CRUD; no crea sesiones ni aplica permisos reales.
- Los listados operativos se filtran por proyecto activo. Dashboard agregado, IRSA y auditoría conservan métricas globales y se identifican como tales en la interfaz.
- Los registros históricos sin Proyecto_ID se asignan al proyecto predeterminado PRJ-SECHURA.
- La geometría de las concesiones proviene de la consulta gráfica pública GeoCatMin/INGEMMET (EPSG:4326). Es referencial y no sustituye catastro certificado, memoria descriptiva ni levantamiento de campo.
- Las áreas nominales se conservan separadas de las áreas GIS: la presentación proporcionada aporta nombres, códigos y hectáreas, pero no coordenadas numéricas.


IMPORTANTE RC 2.9: leer NOVEDADES_RC_2_9.md antes de iniciar. Es obligatorio configurar MASCLI_ADMIN_PASSWORD en el primer arranque.
