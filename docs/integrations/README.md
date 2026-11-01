# Integraciones de SIPGES

Guía de las automatizaciones, los canales de salida, las claves de API y el servidor MCP
(decisiones en [ADR 0014](../adr/0014-automation-and-integration.md)). Todo se configura
en la pantalla **Sistema → Automatizaciones** con rol administrador y vale para el
proyecto activo.

## Automatizaciones

Una regla tiene:

- **Origen**: un módulo de registros (Alertas, Demandas, Eventos…) o un origen del sistema
  (alertas de inteligencia digital, acciones de prevención, vínculos, laboratorio documental,
  IRSA), o cualquier módulo.
- **Eventos**: creación, actualización, eliminación, importación, evidencia subida, cambio de
  clasificación, revisión, corte IRSA o cambio de configuración.
- **Condiciones** sobre el estado actual del registro: `es igual a`, `es distinto de`,
  `contiene`, `mayor o igual`, `menor o igual`, `tiene valor`, `está vacío`. Los números se
  comparan como números y las fechas ISO como texto. `$marking`, `$detail` y `$action` se
  refieren a la clasificación, el detalle y la acción del evento.
- **Acciones**: un aviso en la bandeja (campana) de todos los miembros del proyecto, o un
  mensaje a un canal. El título admite `{id}`, `{modulo}`, `{accion}` y `{Campo}`.

Las reglas nuevas solo reaccionan a eventos posteriores a su creación. Cada entrega se
registra en **Últimas ejecuciones**. Si falla, se reintenta a los 1, 4, 16 y 64 minutos y
después queda como fallida con el error.

### Cuándo se ejecutan

| Hospedaje | Cómo |
| --- | --- |
| Servidor Node (`pnpm --filter @sipges/api start`) | Solo, cada `SIPGES_AUTOMATION_INTERVAL` segundos (30 por defecto, `0` lo apaga). |
| Cloudflare Workers | Un Cron Trigger (`*/15 * * * *` por defecto) ejecuta el trabajo programado dentro del Worker. Para otra frecuencia o un programador externo, llama `GET` o `POST /system/automations/cron` con `Authorization: Bearer $SIPGES_CRON_SECRET` (24 caracteres o más; `CRON_SECRET` también se acepta). |
| Manual | Botón **Ejecutar ahora** en la pantalla. |

## Canales de salida

| Canal | Qué pide | Notas |
| --- | --- | --- |
| Webhook firmado | URL https y secreto de 24+ caracteres | Para n8n, Zapier, Make, Power Automate o un sistema propio. |
| Slack | URL de *Incoming Webhook* (`hooks.slack.com`) | |
| Microsoft Teams | URL de un flujo de Workflows "cuando se recibe una solicitud de webhook" | Envía una Adaptive Card. |
| Discord | URL de webhook del canal | Sin menciones. |
| Google Chat | URL de webhook del espacio (`chat.googleapis.com`) | |
| Telegram | Token del bot y id del chat o `@canal` | El bot debe estar en el chat. |
| Correo | Clave de Resend, remitente verificado y hasta 20 destinatarios | |

Los secretos se cifran con `SIPGES_DATA_KEY` y no vuelven a mostrarse. Solo se aceptan
destinos `https` públicos (sin `localhost`, IP privadas ni nombres internos). De los registros
**restringidos** solo sale el módulo y el id, nunca su contenido.

### Verificar un webhook

Cada envío trae las cabeceras de [Standard Webhooks](https://www.standardwebhooks.com):
`webhook-id`, `webhook-timestamp` y `webhook-signature: v1,<firma>`, donde la firma es
HMAC-SHA256 en base64 de `"<id>.<timestamp>.<cuerpo>"` con el secreto del canal (en texto, sin
el prefijo `whsec_`). Ejemplo en Node:

```js
import { createHmac, timingSafeEqual } from 'node:crypto';

const verify = (secret, headers, body) => {
  const expected = createHmac('sha256', secret)
    .update(`${headers['webhook-id']}.${headers['webhook-timestamp']}.${body}`)
    .digest('base64');
  const given = headers['webhook-signature'].split(' ').map((s) => s.replace(/^v1,/, ''));
  return given.some((s) => s.length === expected.length && timingSafeEqual(Buffer.from(s), Buffer.from(expected)));
};
```

Rechaza los envíos con más de 5 minutos de antigüedad y usa `webhook-id` para descartar
duplicados: un reintento repite el mismo id. El cuerpo JSON trae `type`
(`sipges.<módulo>.<acción>`), `module`, `record_id`, `action`, `detail`, `marking` y `record`
(los campos del registro, o `null` si está restringido).

## Avisos en el dispositivo

La campana muestra los avisos de la bandeja. Además, cada persona puede marcar **Recibir avisos
en este dispositivo** para que lleguen como notificación del sistema (Chrome, Edge, Firefox y
Safari, también en el móvil con la app instalada desde el navegador). Al tocar el aviso se abre
el registro. Si el aviso viene de un registro **restringido**, no llega a los dispositivos del
rol consulta.

Para activarlo, genera un par de claves VAPID una vez y guárdalo como variables del servidor:

```bash
pnpm --filter @sipges/api vapid:keys
```

| Variable | Valor |
| --- | --- |
| `SIPGES_VAPID_PUBLIC_KEY` | Clave pública (87 caracteres). |
| `SIPGES_VAPID_PRIVATE_KEY` | Clave privada (43 caracteres). Secreta. |
| `SIPGES_VAPID_SUBJECT` | `mailto:` de contacto o URL `https` del responsable. |

Sin estas variables el interruptor no aparece. Cambiar las claves invalida las suscripciones
existentes: cada persona debe volver a activarlo. Los dispositivos dados de baja por el
navegador se olvidan solos.

## Claves de API

Se crean en la misma pantalla. La clave (`mscli_<prefijo>_<secreto>`) se muestra **una sola
vez**. Cada clave pertenece a un proyecto y tiene:

- **Permisos**: solo lectura, o lectura y escritura.
- **Restringidos**: si ve o no los registros clasificados como restringidos.

Las claves solo sirven para `/mcp` y para los webhooks de entrada, nunca para la API del
navegador. Lo que escribe una clave aparece en el historial y la auditoría como `api:<nombre>`.
Revoca una clave en cuanto deje de usarse.

## Webhooks de entrada

`POST /hooks/ingest/<módulo>` crea registros en el proyecto de la clave (de **escritura**).
Sirve para Zapier, n8n, Make, Power Automate, formularios web o cualquier sistema que pueda
hacer un POST. `<módulo>` es el tipo de objeto (`alertas`, `demandas`, `eventos`…).

```bash
curl -X POST https://<tu-dominio>/hooks/ingest/demandas \
  -H "Authorization: Bearer mscli_..." \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: pedido-123" \
  -d '{"Demanda": "Acceso a agua", "Prioridad": "Alta"}'
```

- El cuerpo puede ser un registro, una lista o `{"records": [...]}` (hasta 50). También se
  acepta un formulario (`application/x-www-form-urlencoded` o `multipart/form-data`) con un
  registro por envío.
- Se revisan todos los registros antes de escribir el primero. Un error responde `422` (o
  `403` si un registro nombra otro proyecto) con `index`, la posición del registro.
- La respuesta `201` trae `ids`, los identificadores asignados.
- Con `Idempotency-Key` (o la cabecera `webhook-id` de Standard Webhooks) un reintento con la
  misma clave devuelve la primera respuesta, con `Idempotent-Replayed: true`, sin duplicar.
- Cada registro queda en el historial como `api:<nombre de la clave>` y dispara las
  automatizaciones de **creación** como si se hubiera creado en la app.

## Propuestas del analista

En la ficha de cada registro, bajo **Análisis**, el analista propone acciones que una persona
aprueba o descarta (roles analista y administrador):

- **Vínculos** cuando un registro nombra a otro en su texto (por ejemplo, un evento que
  menciona a una comunidad registrada como actor) y aún no están vinculados. Se propone el
  tipo de vínculo del catálogo; nunca alianzas ni conflictos.
- **Seguimientos** para una alerta abierta de nivel alto sin acción que la atienda (crea una
  acción pendiente) o una demanda prioritaria abierta sin compromiso (crea un compromiso).

Nada cambia hasta que alguien aprueba. Cada decisión queda en la auditoría (módulo
*Analista*, acción revisión) y la propuesta no vuelve a aparecer. Las automatizaciones pueden
reaccionar a esas decisiones con el origen **Propuestas del analista**.

## Búsqueda semántica

Con `SIPGES_SEMANTIC_SEARCH=1` la búsqueda (Ctrl/⌘+K y la herramienta MCP `search_records`)
también encuentra registros por significado: "agua" encuentra un "conflicto hídrico" aunque no
compartan palabras. Usa el modelo de embeddings de Ollama ya configurado
(`SIPGES_OLLAMA_URL`, `SIPGES_OLLAMA_EMBED_MODEL`).

- Los vectores se guardan en la base de datos y se calculan poco a poco: cada búsqueda
  procesa hasta 16 registros nuevos o modificados antes de responder.
- Los resultados por significado se combinan con los de texto (fusión por rango recíproco) y
  se marcan como "Relacionado por significado" cuando no comparten palabras.
- Los registros **restringidos** nunca se envían al modelo; siguen apareciendo en la búsqueda
  de texto para quien puede verlos.
- Si el modelo no responde, la búsqueda sigue funcionando solo por texto.

## Tiempo real y trazas

Las pantallas abiertas se actualizan solas: el navegador escucha `GET /system/events`
(*server-sent events*) y, cuando hay actividad en el proyecto, vuelve a pedir sus datos. Cada
evento lleva solo el módulo y la acción, nunca el id ni el contenido de un registro. En
Cloudflare Workers cada conexión puede cortarse y se reanuda sola con `Last-Event-ID`.

Cada respuesta trae `traceresponse` ([W3C Trace Context](https://www.w3.org/TR/trace-context/)).
Si la petición llega con `traceparent`, SIPGES continúa esa traza; si no, empieza una. Los logs
JSON incluyen `trace_id` y `span_id`, y las llamadas salientes a webhooks firmados, Ollama y
S3 llevan `traceparent` con la misma traza, para seguir una operación de punta a punta en
Grafana, Datadog, Honeycomb o cualquier visor compatible con OpenTelemetry.

## OCR de PDF escaneados

El laboratorio documental lee el texto de los PDF. Para los escaneados (sin capa de texto)
el servidor puede usar [OCRmyPDF](https://ocrmypdf.readthedocs.io) con Tesseract instalados
en la misma máquina; el documento no sale del servidor.

| Variable | Valor |
| --- | --- |
| `SIPGES_OCR` | `ocrmypdf` para activarlo. |
| `SIPGES_OCR_LANGUAGES` | Idiomas de Tesseract, por defecto `spa+eng`. |

No está disponible en Cloudflare Workers (no hay binarios de OCR); úsalo en un servidor Node o un
contenedor con `ocrmypdf` y los paquetes de idioma.

## Servidor MCP

`POST /mcp` implementa el transporte *Streamable HTTP* del
[Model Context Protocol](https://modelcontextprotocol.io) sin sesión (versiones 2025-11-25,
2025-06-18 y 2025-03-26).

| Herramienta | Clave | Qué hace |
| --- | --- | --- |
| `list_object_types` | lectura | Tipos de objeto y de vínculo. |
| `search_records` | lectura | Búsqueda de texto completo. |
| `get_record` | lectura | Campos y clasificación de un registro. |
| `get_links` | lectura | Vista 360°: vínculos explícitos e inferidos. |
| `get_timeline` | lectura | Registros fechados en un rango. |
| `get_briefing` | lectura | Informe extractivo con citas. |
| `create_record` | escritura | Crea un registro. |
| `link_records` | escritura | Crea un vínculo tipado. |

Claude Code:

```bash
claude mcp add --transport http sipges https://<tu-dominio>/mcp \
  --header "Authorization: Bearer mscli_..."
```

Otros clientes (Claude Desktop, VS Code, Cursor) aceptan la misma URL y la cabecera
`Authorization` en su configuración de servidores MCP remotos.

## Variables de entorno

| Variable | Para qué | Por defecto |
| --- | --- | --- |
| `SIPGES_AUTOMATION_INTERVAL` | Segundos entre revisiones de reglas en un servidor Node (`0` las apaga). | `30` |
| `SIPGES_CRON_SECRET` o `CRON_SECRET` | Secreto del cron de `/system/automations/cron` (24+ caracteres). | sin cron |
| `SIPGES_VAPID_PUBLIC_KEY`, `SIPGES_VAPID_PRIVATE_KEY`, `SIPGES_VAPID_SUBJECT` | Avisos en el dispositivo (`pnpm --filter @sipges/api vapid:keys`). | apagado |
| `SIPGES_SEMANTIC_SEARCH` | `1` activa la búsqueda semántica con Ollama. | `0` |
| `SIPGES_OCR`, `SIPGES_OCR_LANGUAGES` | OCR local de PDF escaneados con `ocrmypdf`. | apagado |

En Cloudflare Workers, define las variables en `wrangler.jsonc` o como secretos del Worker
(`wrangler secret put`) y vuelve a desplegar, según [la guía de Workers](../deployment/cloudflare-workers.md).
Las conexiones de tiempo real pueden cortarse y se reanudan solas.
