# SIPGES RC 2.4 — Inteligencia documental y digital (motor local)

Desarrollado a partir de RC 2.3, sin eliminar sus módulos. Se agregó un formulario en «Inteligencia de redes sociales» para copiar texto de publicaciones de LinkedIn, Facebook, Instagram, TikTok, YouTube y X, o fragmentos documentales.

**Funcionalidad real:** POST /system/intelligence/analyze-text: detección transparente mediante vocabularios configurados; temas y señales; indicador de prioridad de revisión textual; comparación por coincidencias con narrativas del proyecto; sugerencias de comprobación; SHA-256 y fragmento de evidencia. El texto analizado no se guarda automáticamente.

**Limitaciones:** no se incorpora un modelo de IA semántica o generativa, no se extrae contenido de enlaces, no hay monitoreo en tiempo real, no se certifican hechos y no hay permisos de usuario de producción. Los resultados requieren comprobación humana. No introducir datos confidenciales en entornos públicos. El laboratorio documental RC 2.1 permanece disponible.

**Ejecución:** pip install -r requirements.txt ; uvicorn app:app --reload. Usar un entorno autorizado y asegurar almacenamiento y accesos antes de uso real.
