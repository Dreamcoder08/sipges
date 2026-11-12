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

Después ejecuta de nuevo el instalador. Conserva tus datos, tu clave y tu contraseña. Esto vale para
la instalación por clon; una [instalación gestionada](#instalación-gestionada-la-versión-definitiva)
se actualiza desde el aviso dentro de SIPGES.

## Instalación gestionada (la versión definitiva)

En lugar de ejecutarse desde el clon, el computador puede ejecutar una **versión firmada**: un
paquete construido con `deploy/desktop/package/builder.mjs` y firmado con
`deploy/desktop/updater/release.mjs` ([updater/README.md](updater/README.md)). La aplicación
instalada ya no depende del clon, y una versión más nueva se ofrece dentro de SIPGES («Nueva
versión de SIPGES», «Actualizar»).

| Paso | Windows | Linux |
| --- | --- | --- |
| 1. Cierra SIPGES; el instalador se niega mientras SIPGES responde en el puerto 8000 | Reinicia, o termina `node` en el Administrador de tareas | `pkill -f apps/api/src/main.ts` |
| 2. Respalda la carpeta de estado | [Respaldar y restaurar](#respaldar-y-restaurar) | [Respaldar y restaurar](#respaldar-y-restaurar) |
| 3. Instala la versión | `powershell -ExecutionPolicy Bypass -File deploy\desktop\windows\install.ps1 -Release <carpeta de la versión>` | `deploy/desktop/linux/install.sh --managed <carpeta de la versión>` |

- La raíz de la instalación es `%LOCALAPPDATA%\SIPGES-app` (Windows) o `~/.local/share/sipges-app`
  (Linux): `versions/`, `current.json`, `install.json`, `releases/`, `launcher.log`,
  `run-current.mjs` y el script de arranque. Los accesos directos (Windows) y la entrada del
  lanzador (Linux) apuntan al script de arranque de esa raíz, así que siguen funcionando después
  de cada actualización.
- La carpeta de estado se queda donde está. No se sobrescribe ni se borra nada en ella; solo se
  crean la clave de datos o la contraseña de administrador si faltan. El primer arranque de la
  versión nueva migra la base de datos existente en su sitio: por eso el paso 2 va primero.
- La clave que firmó la versión pasa a ser la única con la que se aceptan las actualizaciones. El
  instalador imprime su huella SHA-256: compárala con la que anotaste al crear la clave.
- Para ofrecer una versión más nueva, copia su carpeta dentro de `releases` en la raíz. En el
  siguiente arranque un administrador ve el aviso; nada se instala antes de «Actualizar».
- Ejecutar de nuevo el instalador conserva la versión instalada y solo renueva los accesos directos.
- El registro es `launcher.log` en la raíz, no en la carpeta de estado: una actualización copia esa
  carpeta y puede moverla mientras SIPGES corre.

### Si una actualización se detiene a medias

Si una actualización falla y ni siquiera su vuelta atrás termina, SIPGES no arranca sobre esos
datos. La persona ve «SIPGES no se inició: … Restaure la copia de seguridad <copia> o contacte con
soporte.» en un cuadro de mensaje (Windows) o en una notificación y la terminal (Linux). Abajo,
`<versión>` es la que dice `current.json` en la raíz.

1. No borres nada.
2. Reintenta la vuelta atrás (termina cuando la causa, por ejemplo un disco lleno, está resuelta):
   `node <raíz>/versions/<versión>/updater/update.mjs --install <raíz> --recover`.
   Si imprime `Recovered`, abre SIPGES.
3. Si no, restaura tú la carpeta de estado: renombra la carpeta dañada (por ejemplo, agrégale
   `.danada`) y copia en la ruta original la copia que nombra el mensaje, o tu propio respaldo.
4. Ejecuta `node <raíz>/versions/<versión>/updater/update.mjs --install <raíz> --recover --accept-restored-state`.
   Se niega mientras la carpeta de estado falta o está vacía; si no, la versión de antes de la
   actualización vuelve a ser la actual y no se toca nada dentro ni al lado de la carpeta de estado.
5. Abre SIPGES.

### Ensayo en Windows (para la visita, roadmap T34)

En una segunda cuenta de Windows o en otro equipo, nunca en el portátil con datos reales. Anota
«pasa» o «falla» en cada línea; ante un fallo, guarda `%LOCALAPPDATA%\SIPGES-app\launcher.log` y el
texto del cuadro de mensaje, y detente. `<raíz>` es `%LOCALAPPDATA%\SIPGES-app`.

1. `node --version` dice 24 o más.
2. Clona o actualiza el repositorio en el commit definitivo y ejecuta `pnpm install --frozen-lockfile`.
3. Construye el paquete en ese mismo Windows (un paquete solo sirve para el sistema donde se
   construyó): `node deploy\desktop\package\builder.mjs --version <versión> --out .data\desktop-packages\sipges-<versión>`.
4. Firma con la clave privada traída en un USB y retira el USB después (la clave no se queda en el
   equipo): `node deploy\desktop\updater\release.mjs --package .data\desktop-packages\sipges-<versión> --out <carpeta de la versión> --key <archivo de la clave> --notes "Qué cambió"`.
5. Si la cuenta tiene la instalación por clon, crea en ella dos registros de prueba (datos
   inventados). Cierra SIPGES por completo (termina los `node` en el Administrador de tareas).
6. Copia `%LOCALAPPDATA%\SIPGES` completa a un disco externo.
7. `powershell -ExecutionPolicy Bypass -File deploy\desktop\windows\install.ps1 -Release <carpeta de la versión>`.
   Anota la huella SHA-256 que imprime y compárala con la de tu clave.
8. `<raíz>` tiene `versions\<versión>`, `current.json`, `install.json`, `releases`,
   `run-current.mjs`, `start.ps1` y `sipges.ico`; `%LOCALAPPDATA%\SIPGES` conserva sus archivos; los
   accesos directos «SIPGES» del menú Inicio y del escritorio apuntan a `<raíz>\start.ps1`
   (clic derecho, Propiedades, Destino).
9. Abre SIPGES desde el acceso directo: Edge abre en modo aplicación antes de 90 segundos; inicia
   sesión; los registros del paso 5 están.
10. Construye y firma una versión mayor (pasos 3 y 4) y copia su carpeta dentro de `<raíz>\releases`.
    Cierra SIPGES por completo y ábrelo: aparece «Nueva versión de SIPGES» con sus notas.
11. Pulsa «Actualizar»: la página se recarga en la versión nueva, `<raíz>\current.json` la nombra y
    existe `%LOCALAPPDATA%\SIPGES.pre-update-…`. Los registros siguen ahí.
12. Fuerza una detención (solo en la cuenta de ensayo): con SIPGES cerrado, en PowerShell:

    ```powershell
    node -e 'const fs=require(`fs`),p=require(`path`),r=process.argv[1],c=JSON.parse(fs.readFileSync(p.join(r,`current.json`))),s=JSON.parse(fs.readFileSync(p.join(r,`install.json`))).stateDir;fs.writeFileSync(p.join(r,`update-journal.json`),JSON.stringify({from:{version:c.version,path:c.path,adopted:false},to:{version:`99.0.0`,path:`versions/99.0.0`},stateDir:s,preCopy:s+`.pre-update-ensayo`,failedAside:s+`.failed-ensayo`,restoring:s+`.restoring-ensayo`,phase:`migrating`}))' "$env:LOCALAPPDATA\SIPGES-app"
    ```

    Abre SIPGES: un cuadro de mensaje dice «SIPGES no se inició: …» y nombra
    `%LOCALAPPDATA%\SIPGES.pre-update-ensayo`; Edge no abre.
13. Sal de la detención como en [Si una actualización se detiene a medias](#si-una-actualización-se-detiene-a-medias),
    pasos 2 y 4 (la carpeta de estado no cambió, así que no hay nada que restaurar): el paso 2 vuelve a
    fallar con código 3; el paso 4 imprime `Accepted the restored state folder`. Abre SIPGES: arranca.
14. Ejecuta de nuevo el instalador del paso 7: dice que ya está instalado y no cambia la versión.

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
- La instalación gestionada se probó de punta a punta solo en Linux (instalar, abrir desde la entrada
  del lanzador, ver el aviso, actualizar, detención y salida). En Windows, `install.ps1 -Release` y
  `start-managed.ps1` solo se revisaron de forma estática: el ensayo de arriba es su primera prueba.
