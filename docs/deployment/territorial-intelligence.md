# Inteligencia territorial y avisos

La evaluación por reglas crea señales pendientes de revisión humana, no predicciones de conflicto.
No modifica IRSA ni requiere contratar IA.

## Activar por proyecto

En Automatizaciones, cargar la plantilla «narrativa → señal → aviso». Las dos reglas se guardan
pausadas: revisar condiciones, umbral y destinatarios antes de activarlas. Registrar narrativas
con descripción y evidencia; el territorio es explícito. Los restringidos no se evalúan con esta
acción. Una evidencia repetida en 24 horas conserva su señal y revisión. El aviso digital enlaza
al detalle de la señal y a la narrativa original.

Para el teléfono, activar notificaciones en el propio dispositivo y ejecutar su prueba. En iOS,
instalar primero la aplicación web en la pantalla de inicio. La aceptación del servicio push
no demuestra recepción/lectura. Configurar MASCLI_VAPID_PUBLIC_KEY, MASCLI_VAPID_PRIVATE_KEY y
MASCLI_VAPID_SUBJECT, conservar las claves mientras haya suscripciones y no publicar la privada.
Telegram/correo requieren sus propios canales autorizados; no reciben la prueba personal push.

## Ejecución y reintentos

Las mutaciones correctas despiertan el motor; Vercel conserva su ejecución con waitUntil.
Una caída del motor no revierte registros ya confirmados. Los cursores y entregas conservan
trabajo pendiente, con límites de tiempo/cantidad por ciclo. El panel muestra el último intento
del proyecto, no una garantía de puntualidad o recepción. Una escritura concurrente solicita
un nuevo barrido; los trabajadores aplican su propio contexto de seguridad y los permisos
vigentes de cada destinatario.

Respaldo nativo: GET /system/automations/cron a las **04:15 UTC diariamente**. Vercel Hobby puede
ejecutarlo dentro de esa hora. Configurar CRON_SECRET; si existe MASCLI_CRON_SECRET, deben
coincidir porque MASCLI le da precedencia. Sin secreto válido, el endpoint rechaza la petición.
Un ejecutor externo autorizado puede llamar al mismo endpoint mediante Bearer para mayor
frecuencia. No se instala un cron frecuente en el repositorio privado ni se contratan servicios.
El servidor persistente utiliza el mismo coordinador con MASCLI_AUTOMATION_INTERVAL.

Los reintentos se atienden al despertar el motor. El cron diario no garantiza detección oportuna
de publicaciones externas durante el día. El estado fallido de una fuente no impide intentar
las entregas pendientes, pero queda registrado y el cron responde con error.

## Fuentes públicas autorizadas

El conector Defensoría del Pueblo conserva título, extracto, URL, fecha publicada, fecha observada,
atribución y huella. No recupera artículos completos ni redes privadas. Está desactivado inicialmente.
Activarlo requiere nota de autorización y revisar búsqueda/territorio; se puede desactivar sin borrar
narrativas. El ámbito elegido por el operador no es una coordenada calculada. Intervalo mínimo
entre consultas: 15 minutos; la frecuencia efectiva depende del ejecutor.

POST /hooks/signals acepta fuente, referencia HTTP/HTTPS, identificador externo, texto y fecha mediante
una clave de integración con permiso de escritura. La URL se conserva y nunca se descarga.
Los reintentos idempotentes no duplican registros. /hooks/ingest/:module sigue disponible.

## GEOCATMIN y conservación

El selector descubre subcapas y escalas de siete servicios oficiales INGEMMET. Las consultas usan
WGS84 y destinos fijos con límites. Relacionar registros con una concesión requiere geometría válida
o código y fuente documentada. Los registros sin ubicación quedan fuera de la intersección.
Si falla INGEMMET, se muestra el error y se conservan las geometrías del proyecto; no se inventan capas
ni coordenadas. Las pruebas controladas no demuestran disponibilidad real o licencia de uso masivo.

Las migraciones 0021–0024 son aditivas. Para detener el flujo, pausar reglas y conectores y retirar
el programador. Revertir código conserva columnas, tablas, datos y entregas pendientes: no ejecutar DROP.

Fuentes oficiales consultadas el 17 de octubre de 2026:

- <https://geocatmin.ingemmet.gob.pe/arcgis/rest/services>
- <https://www.defensoria.gob.pe/wp-json/wp/v2/posts>
- <https://vercel.com/docs/cron-jobs/usage-and-pricing>
- <https://vercel.com/docs/functions/functions-api-reference/vercel-functions-package>

## Verificación del despliegue del 18 de octubre de 2026

El [PR #53](https://github.com/Dreamcoder08/mascli/pull/53) se integró como `6754923`.
La [CI del código](https://github.com/Dreamcoder08/mascli/actions/runs/39087996497) aprobó
651 pruebas API, 218 UI, 6 hosting, contratos/herramientas, tipos, lint, build y referencia Python.
Chromium aprobó 89 pruebas (una omisión existente) y WebKit las 9 de su suite complementaria.
El flujo persistido se comprobó en PostgreSQL aislado; las pruebas con adaptadores no demuestran
la disponibilidad de servicios externos.

Vercel publicó ese merge en producción, despliegue `dpl_6VaDEJuve5PjVU7C9S4a6kS6bd84`, estado READY.
La comprobación pública obtuvo 200 en /health, /login con Accept text/html y sus archivos JS/CSS;
los endpoints runtime, push/state y cron rechazaron las peticiones sin credenciales con 401.
La consulta agrupada de errores/fatales de ese despliegue durante la comprobación no devolvió entradas.
Esto verifica arranque, publicación y acceso anónimo; no sustituye un flujo autenticado en Vercel/Blob.

Pendientes explícitos en el ODD: T1/T2 requieren comprobar las capas reales cuando INGEMMET responda
(desde este entorno devolvió 503); T8 requiere suscripción y confirmación del teléfono, además de
configurar/autorizar los canales y fuentes deseados. La vista previa de esta rama carece de variables
de base de datos y acceso; su backend devuelve 503 aunque el build esté READY. No se reutilizaron
secretos ni datos de producción para resolver esa vista previa.
