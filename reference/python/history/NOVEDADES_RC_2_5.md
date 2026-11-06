# SIPGES RC 2.5 — Inteligencia semántica local

Se mantiene RC 2.4 y todos los módulos existentes. Nuevo endpoint `POST /system/intelligence/semantic-analyze` con tres modos: `rules`, `automatic`, `semantic`.

- Análisis base reproducible con evidencias textuales, SHA256, señales y sugerencias de revisión.
- Interpretación semántica **opcional**: Ollama ejecutado localmente y modelo de embeddings `nomic-embed-text`; similitud vectorial sobre siete conceptos territoriales. No supone acceso automático a publicaciones mediante URL.
- En modo `automatic`, si Ollama falta, se identifica expresamente el retorno a reglas. En modo `semantic`, si falta el modelo, error 503 (sin fingir análisis de IA).
- El contenido no se almacena en este endpoint; permanece visible en el navegador mientras se trabaja. El uso de fuentes requiere permisos y corroboración.

## Activar IA local (opcional)
1. Instale Ollama desde https://ollama.com.
2. Ejecute `ollama pull nomic-embed-text`.
3. Mantenga activo el servidor local Ollama (`ollama serve` si su instalación no lo inició).
4. Inicie SIPGES normalmente y escoja “Solo semántico local” o “Automático”.
5. Si utiliza otro modelo: establezca `SIPGES_OLLAMA_EMBED_MODEL` al nombre del modelo de embeddings instalado.

## Limitaciones críticas
- No hay LLM generativo: se utilizan embeddings y similitud coseno. No se debe presentar como análisis de causalidad, emociones o verificación automática.
- Los umbrales de similitud son experimentales; deben calibrarse para español peruano y contexto minero.
- El sistema heredado no dispone todavía de autenticación/aislamiento empresarial adecuados. No publicar en Internet con datos personales o confidenciales sin reforzar primero la seguridad.
- No es un monitor automático de LinkedIn ni de otras redes; se analiza texto copiado manualmente.
