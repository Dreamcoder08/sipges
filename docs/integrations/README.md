# Integraciones de MASCLI

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
| Servidor Node (`pnpm --filter @mascli/api start`) | Solo, cada `MASCLI_AUTOMATION_INTERVAL` segundos (30 por defecto, `0` lo apaga). |
| Serverless (Vercel) | Un cron llama `GET /system/automations/cron` con `Authorization: Bearer $CRON_SECRET`. Vercel envía esa cabecera si defines la variable `CRON_SECRET` (24 caracteres o más). En el plan Hobby el cron mínimo es diario; para minutos hace falta un plan Pro o un cron externo. |
| Manual | Botón **Ejecutar ahora** en la pantalla. |

Ejemplo de `vercel.json` (solo en planes que admiten crons por minuto):

```json
{ "crons": [{ "path": "/system/automations/cron", "schedule": "* * * * *" }] }
```

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

Los secretos se cifran con `MASCLI_DATA_KEY` y no vuelven a mostrarse. Solo se aceptan
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
(`mascli.<módulo>.<acción>`), `module`, `record_id`, `action`, `detail`, `marking` y `record`
(los campos del registro, o `null` si está restringido).

## Avisos en el dispositivo

La campana muestra los avisos de la bandeja. Además, cada persona puede marcar **Recibir avisos
en este dispositivo** para que lleguen como notificación del sistema (Chrome, Edge, Firefox y
Safari, también en el móvil con la app instalada desde el navegador). Al tocar el aviso se abre
el registro. Si el aviso viene de un registro **restringido**, no llega a los dispositivos del
rol consulta.

Para activarlo, genera un par de claves VAPID una vez y guárdalo como variables del servidor:

```bash
pnpm --filter @mascli/api vapid:keys
```

| Variable | Valor |
| --- | --- |
| `MASCLI_VAPID_PUBLIC_KEY` | Clave pública (87 caracteres). |
| `MASCLI_VAPID_PRIVATE_KEY` | Clave privada (43 caracteres). Secreta. |
| `MASCLI_VAPID_SUBJECT` | `mailto:` de contacto o URL `https` del responsable. |

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

## OCR de PDF escaneados

El laboratorio documental lee el texto de los PDF. Para los escaneados (sin capa de texto)
el servidor puede usar [OCRmyPDF](https://ocrmypdf.readthedocs.io) con Tesseract instalados
en la misma máquina; el documento no sale del servidor.

| Variable | Valor |
| --- | --- |
| `MASCLI_OCR` | `ocrmypdf` para activarlo. |
| `MASCLI_OCR_LANGUAGES` | Idiomas de Tesseract, por defecto `spa+eng`. |

No está disponible en Vercel (no hay binarios de OCR); úsalo en un servidor Node o un
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
claude mcp add --transport http mascli https://<tu-dominio>/mcp \
  --header "Authorization: Bearer mscli_..."
```

Otros clientes (Claude Desktop, VS Code, Cursor) aceptan la misma URL y la cabecera
`Authorization` en su configuración de servidores MCP remotos.
