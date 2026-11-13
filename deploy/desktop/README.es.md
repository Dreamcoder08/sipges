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
  crean la clave de datos o la contraseña de administrador si faltan, y nunca junto a una base de
  datos existente: el instalador se detiene si la base de datos está pero su `data-key` o su
  `admin-password` no (restáuralas desde tu respaldo).
- El primer arranque sobre una base de datos existente copia la carpeta a su lado
  (`<estado>.pre-update-<hora>-first-start-<versión>`, nunca se borra), prueba la versión nueva
  primero en una segunda copia y solo después en la carpeta; si falla, SIPGES no arranca y la
  carpeta queda como estaba. Para hacerlo en una terminal, sin la espera de 300 segundos del acceso
  directo: `node <raíz>/versions/<versión>/updater/update.mjs --install <raíz> --first-start`.
  El paso 2 sigue yendo primero. Cerrar SIPGES durante el primer arranque detiene también sus
  pruebas y devuelve la carpeta desde esa copia; el siguiente arranque lo intenta de nuevo. Si el
  equipo se apagó a mitad, el siguiente arranque devuelve la carpeta igual antes de reintentar.
- Para instalar sobre una copia de la carpeta de estado y dejar la original a la instalación por
  clon (el traslado de datos, [migration/README.md](migration/README.md)): `-State <copia>` en
  Windows, `SIPGES_DESKTOP_STATE=<copia>` en Linux.
- La clave que firmó la versión pasa a ser la única con la que se aceptan las actualizaciones. El
  instalador imprime su huella SHA-256: compárala con la que anotaste al crear la clave.
- Para ofrecer una versión más nueva, copia su carpeta dentro de `releases` en la raíz. En el
  siguiente arranque un administrador ve el aviso; nada se instala antes de «Actualizar».
- Ejecutar de nuevo el instalador conserva la versión instalada y solo renueva los accesos directos.
  También conserva la carpeta de estado anotada en `install.json`, y se detiene sin cambiar nada
  si se le da otra (`-State` o `SIPGES_DESKTOP_STATE`).
- El registro es `launcher.log` en la raíz, no en la carpeta de estado: una actualización copia esa
  carpeta y puede moverla mientras SIPGES corre.
- SIPGES nunca borra las copias al lado de la carpeta de estado (`.pre-update-…`, `.rehearsal-…`,
  `.failed-…`). Cada arranque anota en `launcher.log` cuántas hay y cuánto ocupan
  (`"stateCopies":{"count":…,"bytes":…}` en la línea `started`). Para verlas:
  `node <raíz>/versions/<versión>/updater/update.mjs --install <raíz> --copies`. Para borrar las
  de más de 30 días (cualquier número entero de días):
  `node <raíz>/versions/<versión>/updater/update.mjs --install <raíz> --remove-copies-older-than 30`.
  Nunca borra la copia previa a la actualización más reciente (lo dice con `Kept …`) y se niega
  mientras una actualización quedó a medias (abajo). Respalda antes: lo borrado no vuelve.
- Cerrar SIPGES (Ctrl+C o SIGTERM) espera hasta 15 s a que el servidor se detenga bien; un segundo
  Ctrl+C o SIGTERM lo detiene en el acto (código de salida 1, `stop_forced` en `launcher.log`).

### Si una actualización se detiene a medias

Si una actualización falla y ni siquiera su vuelta atrás termina, SIPGES no arranca sobre esos
datos. La persona ve «SIPGES no se inició: … Restaure la copia de seguridad <copia> o contacte con
soporte.» en un cuadro de mensaje (Windows) o en una notificación y la terminal (Linux). Abajo,
`<versión>` es la que dice `current.json` en la raíz.

1. No borres nada.
2. Reintenta la vuelta atrás (termina cuando la causa, por ejemplo un disco lleno, está resuelta):
   `node <raíz>/versions/<versión>/updater/update.mjs --install <raíz> --recover`.
   Si imprime `Recovered`, abre SIPGES.
   Si se niega con código 3 y dice que la carpeta de estado fue creada de nuevo o que no puede
   probar que quedó restaurada, no borres nada: renombra esa carpeta recién creada (por ejemplo,
   agrégale `.recreada`) y repite el comando. Mientras la detención siga, el instalador también se
   niega («Hay una actualización de SIPGES pendiente o detenida…») y no cambia nada.
3. Si no, restaura tú la carpeta de estado: renombra la carpeta dañada (por ejemplo, agrégale
   `.danada`) y copia en la ruta original la copia que nombra el mensaje, o tu propio respaldo.
4. Ejecuta `node <raíz>/versions/<versión>/updater/update.mjs --install <raíz> --recover --accept-restored-state`.
   Se niega mientras la carpeta de estado falta o está vacía; si no, la versión de antes de la
   actualización vuelve a ser la actual y no se toca nada dentro ni al lado de la carpeta de estado.
5. Abre SIPGES.

### Ensayo en Windows (para la visita, roadmap T34)

El runbook impreso de la visita, con estos pasos dentro de su ensayo previo:
[docs/deployment/desktop-visit.es.md](../../docs/deployment/desktop-visit.es.md).

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
9. Abre SIPGES desde el acceso directo: Edge abre en modo aplicación antes de 300 segundos; inicia
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

### Ensayo automático en Windows

`deploy/desktop/windows/drill.mjs` hace el traslado de la visita, una actualización y una detención
en un Windows real, solo con datos inventados: la instalación por clon de un commit viejo (por
defecto `e490339c` con el instalador por clon de `6d867050`; `--old-commit` toma el commit de la
laptop), datos cargados por la API pública, `snapshot.mjs`; el paquete construido y firmado con una
clave descartable; `install.ps1 -Release … -State <copia>`, `update.mjs --first-start`, el
`start.ps1` instalado, `compare.mjs` (`RESULT: no difference`) y la carpeta original sin cambios;
N+1 firmada en `<raíz>\releases`, ofrecida, pedida con `POST /system/desktop/update` y comparada
otra vez; y una detención (código 3 y el mensaje). GitHub Actions lo corre en `windows-latest`
(`.github/workflows/windows-desktop.yml`) una vez por commit viejo candidato (cada instalador por
clon de `6d867050` a `main`; a mano con `old_commit`, solo ese) y sube los registros. El mismo
workflow arma el kit de la visita con `deploy/desktop/windows/visit-kit.mjs` en una carpeta
temporal e instala desde ella. A mano, en otro equipo o cuenta de
Windows, nunca en la laptop, con el puerto 8000 libre:

```powershell
pnpm install --frozen-lockfile
node deploy\desktop\windows\drill.mjs [--old-commit <commit>] [--work <carpeta nueva>] [--logs <carpeta>]
```

Termina con `DRILL PASSED` (código 0) o `DRILL FAILED: …` (código 1). Mientras corre cambia los
accesos directos «SIPGES» de esa cuenta y al final los devuelve, y el `start.ps1` viejo abre Edge una
vez. Los scripts salen de `git archive HEAD`, como en el USB de la visita: lo que no tiene commit no
se ensaya. Con `SIPGES_DESKTOP_NO_UI=1` el `start.ps1` instalado escribe sus mensajes en la terminal
en vez de mostrar un cuadro y no abre Edge; el ensayo lo usa. `install.ps1` y `start-managed.ps1`
escriben UTF-8 mientras corren, así que quien lee su salida por una tubería recibe los acentos como
se escribieron; el ensayo comprueba `SIPGES está instalado`.

El USB de la visita es un solo comando, en Windows, desde un clon limpio del commit definitivo:
`node deploy\desktop\windows\visit-kit.mjs --version <semver> --key K:\<clave>.pem --out F:\` construye,
crea o reutiliza la clave de firma, firma y escribe `F:\SIPGES-visita` (la versión firmada,
`sipges-scripts.zip`, `fingerprint.txt`, `LEEME.txt`). Cuándo, lo dice el runbook
([desktop-visit.es.md](../../docs/deployment/desktop-visit.es.md)): en la visita se arma en la
laptop misma, desde un segundo clon (`C:\SIPGES-kit`), con `--out F:\` o, con un solo USB,
`--out C:\SIPGES-kit-salida`. Antes de construir se niega, sin escribir nada, si Node es anterior a
24, falta pnpm 12, el clon, la clave o el kit caen dentro del clon viejo o de
`%LOCALAPPDATA%\SIPGES*`, SIPGES responde en el puerto 8000 o falta espacio libre. El job
«laptop-kit» del mismo workflow lo ensaya (`deploy/desktop/windows/laptop-kit.mjs`): instalación por
clon de un commit viejo, segundo clon con su `pnpm install`, las negativas, el kit, la instalación
desde el kit y la comparación; el clon viejo queda igual byte a byte, y mide tiempo y espacio.

## Respaldar y restaurar

La carpeta de estado es todo: la base de datos no sirve sin `data-key`. Es
`%LOCALAPPDATA%\SIPGES` en Windows y `~/.local/share/sipges-local` en Linux, salvo que se haya
elegido otra para una instalación gestionada (`stateDir` en `install.json` de la raíz). La raíz
de la instalación no guarda datos y no se respalda.

Estos son los pasos del simulacro hecho en Linux con datos inventados (roadmap T11,
`deploy/desktop/migration/rehearse.mjs` paso 7). En Windows, usa PowerShell; `E:` es el disco
externo.

Respaldar:

1. Apaga SIPGES para que ningún archivo quede a medias. Instalación gestionada:
   `pkill -f run-current.mjs` (Linux), o termina todos los procesos `node` en el Administrador de
   tareas (Windows), o reinicia el computador. Instalación por clon: `pkill -f apps/api/src/main.ts`,
   o lo mismo en Windows. `http://127.0.0.1:8000/health` ya no debe responder.
2. Copia la carpeta de estado completa a un disco externo o a un almacenamiento cifrado que
   controles, en una carpeta con la fecha y, en una instalación gestionada, la versión de
   `current.json` de la raíz en el nombre:
   `cp -a ~/.local/share/sipges-local /media/<disco>/SIPGES-<fecha>-<versión>` (Linux),
   `Copy-Item -Recurse "$env:LOCALAPPDATA\SIPGES" "E:\SIPGES-<fecha>-<versión>"` (Windows).
3. Comprueba que la copia tiene el mismo número de archivos y de bytes que el original:
   `find <carpeta> -type f -printf '%s\n' | awk '{n++; s+=$1} END {print n, s}'` en cada una
   (Linux), `Get-ChildItem -Recurse -File <carpeta> | Measure-Object -Property Length -Sum` en
   cada una (Windows: `Count` y `Sum`).
4. Abre SIPGES de nuevo.

Restaurar:

5. Apaga SIPGES como en el paso 1.
6. Si la carpeta de estado sigue ahí, renómbrala (agrégale `.danada`); nunca la borres. (El
   simulacro la borró para representar un disco perdido.)
7. Copia el respaldo de vuelta en la misma ruta, con el mismo usuario:
   `cp -a /media/<disco>/SIPGES-<fecha>-<versión> ~/.local/share/sipges-local` (Linux),
   `Copy-Item -Recurse "E:\SIPGES-<fecha>-<versión>" "$env:LOCALAPPDATA\SIPGES"` (Windows).
   Restaura solo un respaldo hecho con la versión instalada ahora. Uno de una versión anterior
   (hecho antes del primer arranque o antes de una actualización) lo abriría la versión nueva
   directamente, sin copia ni prueba previa. Para restaurarlo, antes del paso 8 renombra
   `first-start.json` de la raíz (agrégale `.done-<fecha>`; no borres nada) y ejecuta
   `node <raíz>/versions/<versión>/updater/update.mjs --install <raíz> --first-start`: copia la
   carpeta restaurada a su lado y prueba la versión primero en una segunda copia, como hizo el
   primer arranque.
8. Abre SIPGES, inicia sesión con la contraseña y un código MFA, y abre algunos registros y
   archivos. Para comprobarlo todo, ejecuta `deploy/desktop/migration/snapshot.mjs` antes del
   paso 1 y `compare.mjs` después de este paso, como hizo el simulacro: debe decir
   `RESULT: no difference`.

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
  del lanzador, ver el aviso, actualizar, detención y salida, el traslado de datos desde una
  instalación por clon antigua y el simulacro de respaldo). En Windows, `install.ps1 -Release` y
  `start-managed.ps1` solo se revisaron de forma estática: el ensayo de arriba es su primera prueba.
