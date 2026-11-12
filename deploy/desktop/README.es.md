# SIPGES en tu propio computador (Windows y Linux)

English: [README.md](README.md)

**Usa SIPGES desde tu propio fork, con tus datos en tu propio disco, abierto como cualquier aplicación de escritorio.**
No necesitas ninguna cuenta de pago. Nada sale del computador.

## Cómo funciona la soberanía

| Qué | Dónde vive | Quién lo controla |
| --- | --- | --- |
| El código | Tu fork en tu propia cuenta de GitHub, clonado en este computador | Tú |
| Los datos (base de datos, archivos subidos) | La carpeta de estado, en tu perfil de usuario | Tú |
| Los secretos (clave de datos, contraseña de administrador) | Dos archivos en la carpeta de estado, legibles solo por tu usuario | Tú |
| El servidor | Un proceso en este computador, que escucha solo en `127.0.0.1:8000` | Tú |

| Sistema | Carpeta de estado |
| --- | --- |
| Windows | `%LOCALAPPDATA%\SIPGES` |
| Linux | `~/.local/share/sipges-local` |

Cloudflare y Neon solo hacen falta para **publicar** SIPGES en internet; esta instalación no los usa.
La IA local es opcional: mira [Opcional: IA local](#opcional-ia-local).

## Instalar (una sola vez)

Necesitas [Git](https://git-scm.com/) y Node.js 24 o posterior. En Linux también `curl` y `openssl`
(vienen en la mayoría de las distribuciones). El instalador agrega pnpm 12.11.2 con npm. Si falla, ejecuta `npm install -g pnpm@12.11.2` en una terminal nueva y vuelve a intentar.

| Paso | Windows | Linux |
| --- | --- | --- |
| 1. Haz un fork del repositorio en GitHub y clona tu fork | `git clone <URL de tu fork>` | `git clone <URL de tu fork>` |
| 2. Instala Node.js 24+ y **abre una terminal nueva** para que lo encuentre | `winget install OpenJS.NodeJS.LTS` | Tu gestor de paquetes, o [nodejs.org](https://nodejs.org/) |
| 3. Ejecuta el instalador desde el clon | `powershell -ExecutionPolicy Bypass -File deploy\desktop\windows\install.ps1` | `deploy/desktop/linux/install.sh` |

El instalador instala las dependencias, compila la aplicación web, crea la carpeta de estado y agrega
**SIPGES** al menú Inicio y al escritorio (Windows) o al lanzador de aplicaciones (Linux).
Al terminar te dice dónde está la contraseña de administrador.

## Uso diario

Abre **SIPGES** desde el menú. El primer arranque tarda hasta un minuto; los siguientes son rápidos.

1. Entra como `admin` con la contraseña del archivo `admin-password` (carpeta de estado).
2. En el primer inicio de sesión SIPGES te pide configurar una aplicación autenticadora. El MFA sigue activo.

Cerrar la ventana deja el servidor encendido, así que la próxima apertura es inmediata. Cerrar la
sesión del computador o reiniciarlo lo apaga.

Si la ventana no abre, lee `api.log` en la carpeta de estado. Las ejecuciones nuevas se agregan al final.

## Actualizar

```sh
git pull
```

Después ejecuta de nuevo el instalador. Conserva tus datos, tu clave y tu contraseña.

## Respaldar y restaurar

La carpeta de estado es todo: la base de datos no sirve sin `data-key`.

1. Apaga el servidor para que ningún archivo quede a medias: reinicia el computador o termina el proceso `node`
   (Administrador de tareas en Windows; `pkill -f apps/api/src/main.ts` en Linux).
2. Copia la carpeta de estado completa a un disco externo o a un almacenamiento cifrado que controles.
3. Para restaurar, deja la copia en el mismo lugar (mismo usuario, misma ruta) y abre SIPGES.

Quien obtenga la carpeta obtiene tus datos y la clave para leerlos. Guarda las copias en privado.

## Opcional: IA local

La búsqueda semántica usa un servidor local de [Ollama](https://ollama.com/) y se queda en tu computador.
Instala Ollama, ejecuta `ollama pull nomic-embed-text`, define las variables de entorno de usuario
`SIPGES_OLLAMA_URL=http://127.0.0.1:11434` y `SIPGES_SEMANTIC_SEARCH=1`, y reinicia el servidor.
Detalle de las variables: [docs/deployment/local-install.es.md](../../docs/deployment/local-install.es.md).

## Cambiar el ícono

`sipges.svg` es la fuente. Regenera los otros dos archivos desde `deploy/desktop` (requiere
`rsvg-convert` y `magick` de ImageMagick; ejecútalo con `bash`):

```sh
tmp=$(mktemp -d)
for size in 16 24 32 48 64 128 256; do
  rsvg-convert -w $size -h $size sipges.svg -o "$tmp/$size.png"
done
magick "$tmp"/{16,24,32,48,64,128,256}.png sipges.ico
rsvg-convert -w 512 -h 512 sipges.svg -o sipges.png
rm -r "$tmp"
```

## Límites que debes conocer

- **Este cambio no se probó en un Windows real.** Los scripts siguen Windows PowerShell 5.1 y
  herramientas estándar de Windows, y solo se revisaron de forma estática. Si algo falla,
  `api.log` y el cuadro de mensaje son las primeras pistas.
- Windows abre Microsoft Edge en modo aplicación (siempre está instalado). Linux abre el primero de
  Chrome, Chromium, Edge o Brave que encuentre; si no hay ninguno, tu navegador predeterminado
  (una pestaña normal, sin ventana de aplicación).
- El puerto está fijo en 8000. Si otro programa lo usa, SIPGES no puede arrancar.
- Puede verse una ventana de consola un instante cuando el acceso directo de Windows arranca.
