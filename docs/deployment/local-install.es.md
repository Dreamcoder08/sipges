# SIPGES en tu propia computadora

Esta guía instala SIPGES en una computadora de tu oficina para que todos en tu red lo usen desde el navegador. No necesitas ser desarrollador: ejecutas unos pocos comandos y cada uno te dice qué pasó.

Todo queda en esa computadora: los datos, los archivos de evidencia y los respaldos. Nada se envía a Neon ni a Cloudflare.

[English version](local-install.md)

## Ruta rápida

1. Cifra el disco de la computadora: [Cifrar el disco](#cifrar-el-disco).
2. Instala Docker: [Qué necesitas](#qué-necesitas).
3. Si el cliente **no** trae datos: `./sipges install sipges.local`. Si **trae** datos, ve primero a [Traer los datos del cliente](#traer-los-datos-del-cliente).
4. Haz que los navegadores confíen en la conexión: [Confianza del navegador](#confianza-del-navegador).
5. Guarda una copia de `.env` fuera de la computadora: [Lo que no puedes perder](#lo-que-no-puedes-perder).

## Qué necesitas

| Necesitas | Detalle |
| --- | --- |
| Una computadora siempre encendida | Linux con procesador Intel o AMD. Windows solo con WSL 2, aún sin probar. Las computadoras ARM todavía no son compatibles. |
| Memoria | 4 GB. En reposo SIPGES usó unos 130 MB en nuestra prueba, pero la primera construcción y los PDF grandes necesitan más. |
| Docker | [Docker Engine](https://docs.docker.com/engine/install/) con el complemento Compose, versión 2.24 o posterior. |
| Internet | Para la primera instalación y las actualizaciones. Después no hace falta para usar SIPGES, salvo los mapas. |
| Una carpeta para el proyecto | Una copia del repositorio de SIPGES. Los comandos se ejecutan desde `deploy/local`. |

## Cifrar el disco

SIPGES cifra sus respaldos, pero la base de datos y los archivos de evidencia quedan sin cifrar dentro de la computadora. Si alguien se lleva la computadora o el disco, solo el cifrado de disco los protege.

| Situación | Qué hacer |
| --- | --- |
| Computadora nueva | Activa el cifrado de disco al instalar el sistema. En Ubuntu y Debian la opción usa LUKS y pide una contraseña al encender. |
| Sistema ya instalado sin cifrar | Por lo general hay que reinstalar. Respalda primero y consulta a tu técnico. |
| Discos externos con respaldos o archivos del cliente | Cífralos también. En Ubuntu, la aplicación **Discos** ofrece formato con cifrado LUKS. |

Ten en cuenta dos cosas:

- **Tras cada corte de luz o reinicio alguien debe escribir la contraseña del disco.** Hasta entonces SIPGES no arranca. Anota esto en el procedimiento de la oficina.
- **Sin esa contraseña nadie recupera el disco**, ni siquiera el soporte. Guárdala aparte, junto con la copia de `.env`.

Para comprobarlo, ejecuta `lsblk -o NAME,TYPE,FSTYPE,MOUNTPOINT`. En un disco cifrado verás una línea `crypto_LUKS`.

## Instalar

```bash
cd deploy/local
./sipges install sipges.local
```

Usa el nombre que la gente escribirá en el navegador. Puede ser un nombre como `sipges.local` o la dirección fija de la computadora, como `192.168.1.20`. Tu red debe dirigir ese nombre a esta computadora; por lo general es una línea en la configuración del router. Sin nombre, `./sipges install` usa `localhost`, que solo funciona en la misma computadora.

La primera instalación tarda unos minutos. Al final muestra la dirección, el usuario `admin` y una contraseña. Después:

1. Abre la dirección e inicia sesión.
2. Agrega SIPGES a una aplicación autenticadora cuando te lo pida. Todas las cuentas deben usar una.
3. **Copia `deploy/local/.env` a un lugar seguro, fuera de esta computadora.**

Para cambiar la dirección más adelante, ejecuta otra vez `./sipges install <nuevo nombre>`. Nada más cambia.

## Confianza del navegador

SIPGES siempre usa HTTPS, así las contraseñas nunca cruzan tu red sin protección. En una red privada nadie puede comprar un certificado público para tu nombre, por eso la instalación crea su propia autoridad de certificación. Cada computadora debe confiar en ella una vez.

```bash
./sipges ca
```

Esto crea `sipges-root-ca.crt`. Instala ese archivo en cada equipo:

| Sistema | Cómo |
| --- | --- |
| Windows | Doble clic, **Instalar certificado**, **Equipo local**, **Entidades de certificación raíz de confianza**. |
| macOS | Doble clic, agrégalo a **Sistema** en Acceso a Llaveros, ábrelo y elige **Confiar siempre**. |
| Linux, Chrome | **Configuración > Privacidad y seguridad > Seguridad > Administrar certificados > Autoridades > Importar**. |
| Firefox, cualquier sistema | **Ajustes > Privacidad y seguridad > Certificados > Ver certificados > Autoridades > Importar**. |
| Android, iPhone | Envía el archivo al teléfono e instálalo como certificado de autoridad en Ajustes. En iPhone actívalo además en **Ajustes de confianza de certificados**. |

Hasta que lo hagas, los navegadores muestran una advertencia y la aplicación no se puede instalar ni funcionar sin conexión.

**No abras el puerto 443 a internet.** Esta instalación es para una red privada. Si necesitan entrar desde fuera, usa una VPN.

## Todos los días

| Comando | Qué hace |
| --- | --- |
| `./sipges status` | Muestra qué está en marcha, el último respaldo y cualquier fallo de respaldo. |
| `./sipges stop` / `./sipges start` | Detiene o inicia todo. También arranca solo al reiniciar la computadora. |
| `./sipges logs api` | Muestra la actividad reciente. Otras partes: `db`, `caddy`, `backup`. |

Revisa `./sipges status` una vez por semana. Así te enteras de que falló un respaldo nocturno.

## Respaldos

SIPGES se respalda cada noche a las 2:00, hora de Lima, y conserva los últimos 14. Un respaldo incluye la base de datos y todos los archivos de evidencia, cifrados. Solo cuenta cuando SIPGES ya lo volvió a leer.

Los respaldos están en `deploy/local/backups`. **Un respaldo en la misma computadora no te protege de un disco dañado.** Haz que SIPGES copie cada uno a una carpeta en otro disco (un disco externo cifrado, o la carpeta compartida de otra computadora montada aquí):

```bash
./sipges copy-backups-to /media/usb/sipges-backups
./sipges start
./sipges backup
```

La carpeta debe existir. SIPGES la marca con un archivo `.sipges-backup-copy`, copia allí cada respaldo después de leerlo de vuelta, comprueba la copia con sus sumas de verificación y conserva tantas como `SIPGES_BACKUP_KEEP`. Solo copia a la carpeta marcada: con el disco desconectado no se escribe nada en el disco de esta computadora en su lugar, el respaldo igual cuenta y `./sipges status` dice que la copia falló y por qué. Al volver a conectar el disco ejecuta `./sipges start`: el servicio en marcha sigue viendo la carpeta vacía con la que arrancó, y start le devuelve el disco, así el siguiente respaldo se copia. `copy-backups-to` avisa cuando la carpeta está en el mismo disco que los respaldos, como pasa si se creó con el otro disco desconectado. Para dejar de copiar, quita la línea `SIPGES_BACKUP_COPY_DIR` de `.env` y ejecuta `./sipges start`.

| Comando | Qué hace |
| --- | --- |
| `./sipges backup` | Hace un respaldo ahora. |
| `./sipges backups` | Lista los respaldos por fecha. |
| `./sipges restore 20261106T193243Z` | Reemplaza todo con ese respaldo. Te pide escribir RESTORE. |

Para cambiar la hora, la cantidad o la zona horaria, edita `SIPGES_BACKUP_HOUR`, `SIPGES_BACKUP_KEEP` y `SIPGES_TIMEZONE` en `.env`, y ejecuta `./sipges start`.

Una restauración carga primero el respaldo en una base aparte. Con una frase de paso incorrecta o un archivo dañado se detiene, y SIPGES vuelve con los datos que tenía. Si se detiene más tarde, por ejemplo por un corte de luz, SIPGES queda apagado y lo avisa: ejecuta el mismo `./sipges restore` y termina. Después inicia sesión con los códigos del autenticador que ya usas.

### Lo que no puedes perder

`.env` guarda `SIPGES_BACKUP_PASSPHRASE` y `SIPGES_DATA_KEY`.

- Sin la frase de paso, nadie puede abrir ningún respaldo.
- Sin la clave de datos, no se pueden leer los autenticadores ni los secretos de los canales.

Guarda una copia de `.env` en un lugar seguro, separada de los respaldos. Quien tenga `.env` y los respaldos tiene todos los datos.

### Mudarse a otra computadora

Instala Docker, copia el repositorio, tu `.env` y la carpeta `backups` a los mismos lugares, y ejecuta:

```bash
./sipges install
./sipges restore <nombre del último respaldo>
./sipges ca
```

La computadora nueva tiene un certificado nuevo, así que instala `sipges-root-ca.crt` otra vez en todos los equipos.

## Actualizar

```bash
./sipges update
```

Hace un respaldo, obtiene la versión nueva, reconstruye y reinicia. Los cambios de base de datos se aplican solos.

### Volver atrás

`previous` es la última versión que de verdad arrancó, así que una actualización fallida, aunque la repitas, nunca la reemplaza. Si una actualización sale mal:

1. Ejecuta `./sipges backups` y anota el respaldo tomado justo antes de actualizar.
2. Agrega `SIPGES_IMAGE_TAG=previous` a `.env`.
3. Ejecuta `./sipges restore <ese respaldo>`.

La restauración es necesaria: los cambios de base de datos solo van hacia adelante, y la versión anterior necesita la base anterior. Quita la línea de `.env` cuando salga la versión corregida.

### Ajustes locales

Lo que debe sobrevivir a `./sipges start` y `./sipges update` va en `.env`, nunca en la terminal: una variable exportada dura una sesión, y mientras existe pesa más que `.env`.

- **Que solo esta computadora pueda entrar.** Agrega `SIPGES_BIND_ADDRESS=127.0.0.1` a `.env` y ejecuta `./sipges start`. Sin esa línea, SIPGES escucha en todas las redes de esta computadora (`0.0.0.0`), que es lo que necesitan las demás computadoras de la oficina.
- **Tus propios cambios de Compose.** Escríbelos en un archivo Compose tuyo y nómbralo en `.env` con una ruta absoluta, sin comillas: `SIPGES_COMPOSE_OVERRIDE=/home/tu-usuario/sipges-local/compose.override.yaml`. Cada comando de `./sipges` lo pone encima de `compose.yaml`, así que start, update, stop, logs y los respaldos ven los mismos servicios. Las rutas relativas dentro de ese archivo cuentan desde `deploy/local`. Guárdalo fuera del repositorio y cópialo junto con `.env`: una actualización nunca lo toca.

Si ese archivo no existe, `./sipges` se detiene con `SIPGES_COMPOSE_OVERRIDE names <path>, which does not exist` en vez de seguir sin él. Corrige la ruta o quita la línea. Docker Compose leería solo un `compose.override.yaml` junto a `compose.yaml` únicamente cuando no se nombra ningún archivo, y `./sipges` siempre nombra uno, así que esta línea es la única entrada. Pertenece a ese `.env`, así que un simulacro con `SIPGES_ENV_FILE` nunca toma el tuyo.

### Ajustado a la computadora

`./sipges install`, `start` y `update` leen los procesadores y la memoria que tiene Docker (en Windows y macOS, la máquina virtual de Docker) y escriben dos líneas en `.env`, después del comentario `# Sized by ./sipges`:

| Ajuste | Valor |
| --- | --- |
| `SIPGES_API_MEMORY` | Un cuarto de la memoria, desde `1g` (por debajo de 8 GiB, como antes) hasta `4g` |
| `SIPGES_DB_POOL_MAX` | Una conexión a la base por procesador, mínimo 4 y máximo 40, para que dos APIs queden por debajo de las 100 de PostgreSQL |

El comando dice lo que eligió (`Sized for 16 CPUs and 32 GiB: …`). Una computadora más grande, o más memoria para Docker, se toma en el siguiente `./sipges start` o `update`. Para conservar valores propios, agrega `SIPGES_SIZING=manual` a `.env` junto con tus `SIPGES_API_MEMORY` y `SIPGES_DB_POOL_MAX`. Si Docker no informa su tamaño, no se escribe nada y cada API conserva 1 GiB y 4 conexiones.

### Dos réplicas de la API

En una sola computadora, una segunda copia de la API da disponibilidad, no velocidad: las dos comparten el mismo procesador, memoria y base de datos. Lo que da:

- **Turnos.** Caddy reparte las solicitudes entre las dos API por turnos (round robin).
- **Chequeos de salud.** Caddy le pregunta a cada API `/health/ready` cada 5 segundos y salta la que no responde; Docker también revisa cada una (`./sipges status` muestra `healthy`). Una solicitud que no llega a una API prueba con la otra.
- **Actualizar sin corte.** `./sipges update` aplica los cambios de la base de datos, reinicia la primera API y espera a que esté sana, y luego hace lo mismo con la segunda. Si la versión nueva nunca queda sana, la segunda API sigue sirviendo la versión que tenía.

Para activarlo, agrega `SIPGES_API_REPLICAS=2` a `.env` y ejecuta `./sipges start`. Para volver a una, ponlo en `1` (o quita la línea) y ejecuta `./sipges start`: la segunda API se elimina. Cualquier otro valor detiene `./sipges` con `SIPGES_API_REPLICAS must be 1 or 2`. Cada API usa la memoria y las conexiones de [Ajustado a la computadora](#ajustado-a-la-computadora).

- La automatización programada corre solo en la primera API, así que se pausa los segundos que esa API se reinicia.
- Si usas `SIPGES_COMPOSE_OVERRIDE`, un cambio que hagas ahí a `api` no llega a la segunda API, `api-2`: dale a `api-2` el mismo cambio.
- Los cambios de la base de datos corren mientras la versión anterior todavía sirve. Por eso, para quien escribe SIPGES: una migración puede agregar, pero no quitar ni renombrar nada que la versión anterior todavía lea; eso espera a una versión posterior ([ADR 0035](../adr/0035-local-install-two-api-replicas.md)).

## Traer los datos del cliente

Los archivos del cliente van en una carpeta **fuera** de la carpeta de SIPGES, por ejemplo un USB en `/media/usb/cliente`. Nunca cambies los permisos del original: trabaja sobre una copia.

| Paso | Comando | Qué cambia |
| --- | --- | --- |
| 1. Preparar | `./sipges prepare sipges.local` | Crea la base vacía, sin iniciar la aplicación. |
| 2. Ver qué hay | `./sipges inventory /media/usb/cliente` | Nada. |
| 3. Probar | `./sipges import ...` | Nada. |
| 4. Importar | `./sipges import ... --apply` | Escribe, después de hacer un respaldo. |

### Ver qué hay en la carpeta

```bash
./sipges inventory /media/usb/cliente
```

Esto no cambia nada: la carpeta se monta en solo lectura, en un contenedor sin red y sin acceso a la base de datos. Un archivo que SIPGES no puede leer no es un problema aquí: es una línea del informe.

En pantalla solo ves conteos. El informe completo es un archivo JSON en `deploy/local/imports`:

| Parte | Qué dice |
| --- | --- |
| `totals`, `byType`, `byReason` | Cuántos archivos hay de cada tipo, su tamaño, cuántos se pueden leer y por qué los demás no. |
| `duplicates` | Archivos con bytes idénticos, hallados por SHA-256. |
| `tables` | Por cada XLSX y CSV: nombres de hojas, encabezados de columnas y cantidad de filas. Nunca el valor de una celda. |
| `files` | Cada archivo con su ruta, tamaño, huella y veredicto. |

| Veredicto | Significado | Qué hacer |
| --- | --- | --- |
| `readable` | SIPGES lo abrió. En un PDF no significa que tenga texto: un PDF escaneado es legible y no tiene texto. | Nada. |
| `not-inspected` | Un tipo que este informe no abre, como las imágenes. Se cuenta y se le calcula la huella. | Nada. |
| `encrypted` | Protegido con contraseña. | Pide al cliente una copia abierta. |
| `legacy-format` | Un `.doc`, `.xls` o `.ppt` antiguo. | Guárdalo en el formato nuevo desde Office, en una copia. |
| `corrupt` | Dañado, o no es en realidad el formato que dice su nombre. | Pide otra copia. |
| `permission-denied` | SIPGES no tiene acceso. | Sigue los pasos de [Permisos de la carpeta](#permisos-de-la-carpeta). |
| `empty`, `too-large`, `link`, `special-file` | Vacío, supera los límites de seguridad, un enlace (nunca se sigue) o no es un archivo normal. | Revísalo a mano. |

Un encabezado de columna también es una celda, y nada en un archivo prueba que la primera fila no tenga datos de una persona: `Juan Perez` sobre una columna de números se ve igual que `Monto`. Por eso, de forma predeterminada, SIPGES muestra un encabezado solo cuando Excel marca esa fila, con un filtro o un panel inmovilizado. Lo demás, incluido todo CSV, dice `headersWithheld: unconfirmed` y conserva sus conteos de filas y columnas.

Después de revisar esos archivos tú mismo, pide el resto:

```bash
./sipges inventory /media/usb/cliente --show-unconfirmed-headers
```

Ese informe puede contener datos reales si un archivo no tiene fila de encabezados. Una celda que parece un valor, como un número de documento, un correo o una fecha, aparece como `[withheld]` en ambos informes, pero ese filtro no detecta un nombre. **Léelo tú antes de compartirlo con alguien o con cualquier herramienta.**

**Trata el informe con la misma reserva que los archivos.** No tiene valores de celdas, pero los nombres de archivos, hojas y columnas pueden incluir el nombre de un cliente o de una persona. Léelo antes de compartirlo con alguien o con cualquier herramienta.

### Qué archivos se aceptan

| Qué tiene el cliente | Comando | Formato aceptado |
| --- | --- | --- |
| Una carpeta de la instalación antigua de SIPGES | `import legacy` | Una carpeta con `data/auth_global.db` y `data/sipges.db`, ambos SQLite, más bases por proyecto, archivos `irsa_config.json` y los archivos de `data/uploads`, si existen. |
| La matriz Base Maestra | `import base-maestra` | Un archivo JSON UTF-8 con la forma `{"Módulo": [{...}, {...}]}`, sin marca de orden de bytes. |

**Excel, CSV, Word y PDF no se importan en lote.** El informe de inventario es el primer paso para diseñar ese importador con las columnas reales. Mientras tanto, cada archivo se puede adjuntar como evidencia dentro de la aplicación.

### Permisos de la carpeta

SIPGES lee la carpeta mediante el grupo de tu propio usuario, así que nadie más en esta computadora necesita acceso. Si la importación dice `SIPGES cannot read`, copia la carpeta a esta computadora y ejecuta sobre la copia:

```bash
chgrp -R "$(id -gn)" /ruta/de/la/copia
chmod -R u+rwX,g+rX,o-rwx /ruta/de/la/copia
```

Si avisa que otros usuarios pueden leer la carpeta, el segundo comando lo cierra en una copia.

Si dice que el grupo se comparte con otras cuentas, tu computadora da un mismo grupo a varios usuarios, y ellos podrían leer los archivos del cliente. Crea una cuenta para SIPGES con `sudo adduser sipges`, agrégala al grupo `docker` y ejecuta todo desde esa cuenta.

### Una instalación antigua de SIPGES

Esto necesita una base que la aplicación nunca haya usado, así que hazlo **en lugar de** `./sipges install`:

```bash
./sipges prepare sipges.local
./sipges import legacy /media/usb/cliente            # prueba, no escribe nada
./sipges import legacy /media/usb/cliente --apply    # escribe
./sipges import legacy /media/usb/cliente --verify   # compara ambos lados
./sipges start
```

Cada ejecución muestra una línea por tabla: filas en el archivo, filas utilizables, filas escritas y filas en la base. Corrige o acepta cada problema que nombre antes de `--apply`.

Si la aplicación ya arrancó, aunque nadie haya iniciado sesión, `prepare` y la importación se niegan y no escriben nada. Empieza de nuevo: `./sipges wipe`, luego `prepare`.

Si `--apply` falla a mitad de camino, puede que las cuentas estén en la base sin registros, y un segundo intento se niega. Corrige lo que indica el informe y ejecuta `./sipges wipe`, `./sipges prepare` y la importación otra vez. El respaldo que hizo `--apply` no sirve aquí: restaurarlo inicia la aplicación.

El [manual de migración](../migration/data-migration.md), en inglés, explica cada código de problema.

### Un archivo Base Maestra

Esto funciona en cualquier momento, con SIPGES en marcha:

```bash
./sipges import base-maestra /media/usb/cliente/seed.json                      # prueba
./sipges import base-maestra /media/usb/cliente/seed.json --apply              # escribe
./sipges import base-maestra /media/usb/cliente/seed.json --scope C/P --apply  # otro proyecto
```

Solo inserta: un registro existente queda como está, así que repetir la importación es seguro y nunca deshace una edición. Una fila de otro proyecto detiene todo el archivo antes de escribir nada.

## Autenticador de los usuarios importados

La gente entra con su contraseña anterior. Las sesiones no se trasladan, así que todos deben iniciar sesión de nuevo. Lo que pasa después depende de cada persona:

| Situación de la persona | Qué pasa | Qué hacer |
| --- | --- | --- |
| Ya usaba autenticador | Sus códigos siguen funcionando. El secreto se migró sellado con `SIPGES_DATA_KEY`. | Nada. |
| No tenía autenticador | SIPGES le pide configurarlo en su primer inicio de sesión. | Tener el teléfono a mano. |
| Perdió el teléfono o ya no tiene la entrada | No puede entrar. | Un administrador usa **Restablecer MFA** en Administración, dentro del proyecto activo. |

**Restablecer MFA** borra el autenticador y cierra todas las sesiones de esa persona. En su siguiente inicio de sesión configura uno nuevo.

**Recomendación antes de usar datos reales:** la instalación antigua guardaba los secretos del autenticador sin cifrar en `auth_global.db`, así que quien tuvo una copia de esa carpeta los pudo leer. Si esa carpeta circuló por USB o por correo, restablece el MFA de cada cuenta después de importar, y guarda el USB bajo llave.

No cambies `SIPGES_DATA_KEY` a mano: los autenticadores dejarían de leerse.

## Credenciales externas

SIPGES funciona completo sin ninguna de estas credenciales. Cada una activa una función opcional y ninguna se ha probado todavía en esta instalación local. Compruébala antes de prometerla.

Las que van en `.env` se aplican con `./sipges start`. Las de canales se escriben dentro de la aplicación.

| Función | Qué necesitas | Dónde va | Requisito |
| --- | --- | --- | --- |
| Inicio de sesión con Google | Cliente OAuth de Google | `.env`: `SIPGES_GOOGLE_CLIENT_ID`, `SIPGES_GOOGLE_CLIENT_SECRET` y, opcional, `SIPGES_GOOGLE_ADMIN_EMAIL` | Google exige HTTPS y no acepta direcciones IP: hace falta un dominio público. Con `192.168.1.20` no funciona. Autoriza `https://<tu dominio>/auth/google/callback`. |
| Avisos en el dispositivo (push) | Nada: `./sipges install`, `start` y `update` agregan un par de claves VAPID al `.env` la primera vez y lo conservan | `.env`: `SIPGES_VAPID_PUBLIC_KEY`, `SIPGES_VAPID_PRIVATE_KEY`, `SIPGES_VAPID_SUBJECT` (las claves que pongas tú nunca se reemplazan) | Cada dispositivo los activa en Avisos y debe confiar en el certificado (`./sipges ca`); el servidor necesita internet para llegar al servicio de avisos del navegador. Un par nuevo desconecta a todos los dispositivos suscritos. |
| Correo | Cuenta de [Resend](https://resend.com): clave, remitente verificado y hasta 20 destinatarios | En la aplicación, como canal de correo | No se usa un servidor SMTP propio. El servidor necesita internet. |
| Slack, Teams, Discord, Google Chat, Telegram | URL de webhook, o token del bot y chat en Telegram | En la aplicación, como canal | El servidor necesita internet. |
| Resumen asistido por IA | Clave de Anthropic | `.env`: `SIPGES_ANALYST_PROVIDER=anthropic`, `ANTHROPIC_API_KEY` y, opcional, `SIPGES_ANALYST_MODEL` | Sale información hacia un servicio externo. Sin esto, SIPGES da el resumen determinista. |
| Resumen asistido con cualquier modelo compatible con OpenAI | Raíz de la API y clave del proveedor (OpenAI, DeepSeek, OpenRouter, Groq, vLLM), o un Ollama local | `.env`: `SIPGES_ANALYST_PROVIDER=openai-compatible`, `SIPGES_ANALYST_BASE_URL` (por ejemplo `https://api.deepseek.com`; se añade `/v1/chat/completions` salvo que la URL ya termine en `/v1`), `SIPGES_ANALYST_API_KEY` (no hace falta en un host de loopback), `SIPGES_ANALYST_MODEL` (obligatorio, por ejemplo `deepseek-chat` o `llama3.1:8b`) | La URL debe ser `https`, o `http` en `localhost`/`127.x`/`::1`. La información sale hacia el proveedor que elijas; enviar datos reales es decisión del responsable de los datos. Sin esto, SIPGES da el resumen determinista. |
| Búsqueda semántica | Un servidor Ollama con un modelo de embeddings | `.env`: `SIPGES_OLLAMA_URL`, `SIPGES_OLLAMA_EMBED_MODEL`, `SIPGES_SEMANTIC_SEARCH=1` | La dirección debe alcanzarse desde el contenedor: `localhost` sería el propio contenedor. Si Ollama no es local, los textos salen seudonimizados y solo con **Envío a IA externa** activado. |

Más detalle en [integraciones](../integrations/README.md).

Las claves de `.env` son secretos: nunca las envíes por correo ni las pegues en un chat. Las de canales se guardan selladas con `SIPGES_DATA_KEY`.

## Analista con tu suscripción de Claude (solo local)

En esta computadora el analista de Inicio puede responder con tu cuenta de claude.ai a través de un puente personal. El puente no forma parte del repositorio ni de `./sipges`:

- Vive en `~/.local/share/sipges-claude-bridge`. Esa carpeta guarda un secreto: no la compartas ni la copies a otro equipo.
- Corre como el contenedor de Docker `sipges-claude-bridge`, en la red `sipges_frontend`, sin puertos publicados.
- Usa tu sesión de claude.ai guardada en `~/.claude`.

| Para | Ejecuta |
| --- | --- |
| Ver si está en marcha | `docker ps --filter name=sipges-claude-bridge` |
| Iniciarlo | `docker start sipges-claude-bridge` |
| Detenerlo | `docker stop sipges-claude-bridge` |
| Volver a iniciar sesión cuando venció | Ejecuta `claude` en la computadora (no en el contenedor), inicia sesión otra vez y luego `docker restart sipges-claude-bridge` |

Si el puente está detenido, tu sesión venció o se agotó la cuota de tu suscripción, Inicio muestra «El analista no respondió: el servicio de IA no está disponible. Prueba de nuevo en unos minutos o avisa a quien administra SIPGES.» y ofrece buscar la pregunta en los registros. La búsqueda sigue funcionando.

## Si algo sale mal

| Qué ves | Qué hacer |
| --- | --- |
| `Docker is not running` | Inicia Docker, o agrega tu usuario al grupo `docker` y vuelve a entrar. |
| `the database did not become ready` | Ejecuta `./sipges logs db`. Tras un corte de luz la base puede tardar en recuperarse: espera y vuelve a intentar. |
| `the app has already run here` | `prepare` es solo para una instalación sin estrenar. Para empezar de nuevo: `./sipges wipe`, luego `./sipges prepare`. |
| `no SIPGES build here yet` | Ejecuta `./sipges prepare` primero. |
| `run this as the user who installed SIPGES` | No uses `sudo`. Ejecuta el comando con tu usuario normal. |
| El navegador dice que el certificado no es de confianza | Instala `sipges-root-ca.crt` en ese equipo. Después de `./sipges wipe` el certificado es nuevo: instálalo otra vez. |
| Una página en blanco | Usaste otro nombre o dirección. Usa el de la instalación o cámbialo con `./sipges install <nuevo nombre>`. |
| El estado muestra un fallo de respaldo | Ejecuta `./sipges logs backup`. Lo habitual es falta de espacio en disco. |
| `SIPGES did not become ready` | Ejecuta `./sipges logs api` y guarda la salida para soporte. No contiene contraseñas. |
| El puerto 80 o 443 ya está en uso | Define `SIPGES_HTTP_PORT` y `SIPGES_HTTPS_PORT` en `.env` y agrega el puerto a la dirección. |

Para borrar todo de esta computadora, ejecuta `./sipges wipe`. Los respaldos y `.env` se quedan hasta que los borres tú.

## Lo que aún no incluye

| Falta | Efecto |
| --- | --- |
| OCR | Los PDF escaneados no aportan texto. |
| Importación masiva de Excel o CSV | Se diseñará a partir del informe de inventario. |
| Imágenes listas | Cada instalación construye desde el código y necesita el repositorio. |
| Computadoras ARM y Windows sin probar | Solo Linux en Intel o AMD está comprobado. |

La guía técnica para quien mantiene la instalación está en la [versión en inglés](local-install.md#for-the-person-maintaining-this).
