# Visita a la laptop: instalar la versión definitiva de SIPGES

Runbook impreso para una sola visita a la laptop Windows de la usuaria (closure-roadmap T34). Se instala la
versión definitiva **al lado** de la que ya usa y se trasladan sus datos a una **copia**: la carpeta original
y la instalación vieja no se tocan. Marcá cada casilla al terminar el paso. Si algo no coincide con lo que
dice «Tenés que ver», aplicá la [Regla de corte](#3-regla-de-corte).

No escribas en esta hoja nombres, contenidos de registros, contraseñas ni códigos. Solo fechas, versiones,
números de archivos y bytes.

Referencias: [deploy/desktop/README.es.md](../../deploy/desktop/README.es.md),
[deploy/desktop/updater/README.md](../../deploy/desktop/updater/README.md),
[deploy/desktop/migration/README.md](../../deploy/desktop/migration/README.md).

## Antes de empezar: qué no se probó en Windows

El traslado, la actualización, la detención y el respaldo se probaron de punta a punta en Linux con
datos inventados. En Windows, el [ensayo automático](#ensayo-en-otra-pc-con-windows) pasó una vez en
`windows-latest` (PR #419: clon de `e490339c` con el instalador de `6d867050`), también con datos
inventados. Lo marcado con ⚠ no está en ningún README: lo agrega este runbook.

| Qué | Estado en Windows |
| --- | --- |
| `install.ps1 -Release … -State …`, `start-managed.ps1` | Ensayo automático (PR #419) |
| El cuadro de mensaje de detención | Solo revisión estática (el ensayo lo escribe en la terminal) |
| `update.mjs --first-start` sobre NTFS, `snapshot.mjs` y `compare.mjs` | Ensayo automático (PR #419), lanzados desde Node |
| `builder.mjs` y `release.mjs` | Ensayo automático (PR #419) |
| `visit-kit.mjs` y la instalación desde su carpeta | Job «visit-kit» de la misma ejecución (anotá el resultado) |
| El kit armado en un segundo clon al lado de una instalación por clon, sus negativas (clon viejo, SIPGES abierto), el clon viejo intacto y la instalación desde el kit | Job «laptop-kit» de la misma ejecución (anotá el resultado) |
| ⚠ Las negativas por Node, pnpm y espacio libre | Solo pruebas en Linux con sondas simuladas |
| ⚠ Llevar los scripts como `.zip` (`git archive`, `Expand-Archive`) | Ensayo automático (PR #419) |
| ⚠ Guardar y devolver los accesos directos (`.lnk`) | Solo el destino se comprobó; la copia y la devolución no se probaron |
| ⚠ Crear la clave, calcular la huella, contar archivos con `-Force` | Ensayo automático (PR #419) |
| ⚠ Comprobar «SIPGES cerrado», la memoria USB, la huella anotada a mano | No probado |
| ⚠ Que el kit borre su paquete fallido y el reintento arme el kit; la contraseña oculta en la consola de Windows; la línea `Managed install` de `compare.mjs` | Solo pruebas en Linux (paquete y servidor simulados; terminal real solo en Linux); las del kit corren también en el job «visit-kit» (anotá el resultado) |
| ⚠ F4: `install.ps1` se niega con una actualización pendiente o detenida (`update-journal.json`) | No probado en Windows hasta que el ensayo automático lo cubra |
| ⚠ F7: el texto de detención que nombra la carpeta de datos gestionada | No probado en Windows hasta que el ensayo automático lo cubra |
| ⚠ `install.ps1` se niega con un `-State` que es un enlace o una unión (junction) | No probado en Windows hasta que el ensayo automático lo cubra |
| ⚠ `install.ps1` se niega con un `-State` que lleva a la carpeta de datos original (la original misma, sin instalación gestionada) | Lo ejecuta el drill de Windows (paso 3 de `drill.mjs`); probado en Windows solo si esa ejecución del CI pasó (anotá el resultado) |

El ensayo automático (`deploy\desktop\windows\drill.mjs`) corre ahora una vez por cada commit que la
laptop pudo haber instalado (sección 1). Lo que vale para la visita es la ejecución sobre el commit de
T27, anotada en «Datos de esta visita».

## Datos de esta visita

En los comandos, `E:` es el disco externo del respaldo, `K:` el USB de la clave y `F:` el USB de la
visita, que solo se usa si está formateado en NTFS. Lo normal es que el kit quede en la laptop, en
`C:\SIPGES-kit-salida`: donde dice `F:\SIPGES-visita`, usá `C:\SIPGES-kit-salida\SIPGES-visita` (el
`LEEME.txt` del kit ya trae la ruta correcta). Si Windows les da otras letras, cambialas en cada
comando.

| Dato | Valor |
| --- | --- |
| Fecha de la visita (`<fecha>`, por ejemplo `2026-12-05`) | |
| Versión definitiva (`<versión>`, por ejemplo `1.0.0`) | |
| Commit definitivo (`git log --oneline -1` al construir) | |
| Huella SHA-256 de la clave (anotada en el paso K, de `fingerprint.txt`) | |
| Commit de la instalación vieja (respuesta T27 y paso 2) | |
| Carpeta del clon viejo (`<clon>`, paso K) | |
| Clon viejo antes del kit: `git log --oneline -1` y si `status` imprimió algo (paso K) | |
| Kit en `F:\SIPGES-visita` o en `C:\SIPGES-kit-salida\SIPGES-visita` | |
| Job «laptop-kit»: `LAPTOP KIT REHEARSAL PASSED`, tiempo y espacio medidos (sección 1) | |
| Respaldo en `E:`: archivos / bytes (paso 1) | |
| `%LOCALAPPDATA%\SIPGES` al cerrar SIPGES: archivos / bytes (paso 3) | |
| Fecha del ensayo en otro Windows (sección 1) | |
| Ensayo automático: `DRILL PASSED` (fecha y ejecución de Actions o PC) | |

## 1. Antes de salir de casa

- [ ] **Condiciones de entrada.** En `odd/tasks/closure-roadmap.md` están cerradas T6–T9, T11 y T33, y la
  versión definitiva sale de un commit de `main` que ya tiene el trabajo de escritorio (PR #401).
- [ ] **Respuestas de T27** anotadas en el Log de `closure-roadmap.md`. Este runbook usa: cómo se instaló
  (clon más `install.ps1`), el commit, Windows, `node --version` (24 o más; si es menor, la visita no
  se hace), si hay MFA y **quién tiene el autenticador de la cuenta `admin`** (hace falta un código en
  los pasos 2 y 5), el tamaño de `%LOCALAPPDATA%\SIPGES` y lo que haya fallado.
- [ ] **Traslado ensayado desde el commit de la laptop**, en Linux, desde el checkout definitivo:

  ```sh
  node deploy/desktop/migration/rehearse.mjs <commit de T27>
  ```

  Tenés que ver `REHEARSAL PASSED` y `RESULT: no difference` en cada comparación. Tiene que correrse con
  los mismos scripts que viajan en el USB (formato de instantánea 3): un ensayo hecho con scripts
  anteriores no cuenta. Si lo cortás con Ctrl+C, detiene y espera cada proceso que arrancó y sale con
  `130`; repetilo entero.
- [ ] **Qué llevar para armar el kit en la laptop** (el kit se arma allí, en el [paso K](#paso-k--armar-el-kit-en-la-laptop),
  no en casa):
  - El commit definitivo y la versión, anotados en «Datos de esta visita».
  - El USB de la clave `K:`. Si ya firmaste algo con una clave, llevala en ese USB como
    `K:\sipges-clave-actualizaciones.pem`: el kit la reutiliza. Si no, el kit la crea ahí.
  - El kit se escribe en la laptop, en **`C:\SIPGES-kit-salida`**, fuera del clon viejo y de
    `%LOCALAPPDATA%\SIPGES*`. Un segundo USB `F:` solo si está formateado en **NTFS**; **nunca**
    uno FAT32 o exFAT (los pendrives suelen venir así): el paquete tiene enlaces de carpeta, y esos
    formatos no los guardan. Ante la duda, `C:\SIPGES-kit-salida`.
  - El disco externo `E:` del respaldo (más abajo). La clave nunca va en él.
  - **Red** en la casa para `git clone` y `pnpm install` (Wi-Fi, o tu teléfono como punto de acceso;
    no el de la usuaria, que hace falta para el MFA).
  - **Tiempo**: el job «laptop-kit» de Actions mide el clon, la instalación de dependencias y el kit
    (`measures.txt` en sus registros y el resumen del job); anotalo en «Datos de esta visita». En
    `windows-latest`, con caché, `pnpm install` tardó 10 s y el kit 22 s (PR #420); en la laptop,
    que descarga las dependencias y es más lenta, reservá **una hora** para el respaldo y el paso K
    (estimación, no medida en la laptop).
  - **Espacio**: el paso K pide **5 GB libres** en `C:` antes de clonar, además de lo que pide el paso 0.
- [ ] **Job «laptop-kit»** del commit definitivo en verde: termina en `LAPTOP KIT REHEARSAL PASSED`.
  Ensaya el paso K al lado de una instalación por clon, con datos inventados: el kit se niega con
  `--out` dentro del clon viejo y con SIPGES abierto, se arma con SIPGES cerrado, el clon viejo queda
  igual byte a byte, sus accesos directos lo siguen abriendo hasta la instalación del paso 3, y la
  instalación desde el kit compara `RESULT: no difference`. Sin ese verde, el kit no se arma en la
  laptop.
- [ ] **Ensayo completo en otra cuenta de Windows o en otro equipo**, nunca en la laptop, con datos
  inventados y un kit armado allí con el paso K (una clave de ensayo, no la de la laptop). Fecha: ____________
  1. T10 líneas 1–3: `node --version` dice 24 o más; clon del repositorio en el **commit de T27**;
     `powershell -ExecutionPolicy Bypass -File deploy\desktop\windows\install.ps1`. Abrí SIPGES y creá
     algunos registros y un archivo subido (inventados).
  2. Las secciones 2 y 3 de este runbook enteras, en orden, incluida la regla de corte una vez.
  3. Volvé a apuntar los accesos directos a la versión nueva con el comando de instalación del paso 3 (dice
     `SIPGES ya está instalado`) y hacé los pasos 10 a 14 del
     [ensayo de README.es.md](../../deploy/desktop/README.es.md#ensayo-en-windows-para-la-visita-roadmap-t34)
     (aviso, actualización, detención forzada y salida). Sacá una foto del aviso «Nueva versión de
     SIPGES» para el paso 8.
  4. Cualquier «falla»: no hay visita hasta corregirla con su prueba.
- [ ] **Ensayo automático por commit candidato.** Todavía no se sabe qué commit tiene la laptop, así que
  GitHub Actions («Windows desktop drill») corre el ensayo una vez por cada commit que pudo haberse
  instalado por clon; uno que falla no detiene los demás. Anotá el resultado de la ejecución sobre el
  commit definitivo (pestaña Actions); el que decide es el del commit de T27:

  | Commit | Qué es | `DRILL PASSED` (fecha, ejecución) |
  | --- | --- | --- |
  | `e490339c` con el instalador de `6d867050` | Primer ensayo (PR #419) | Pasó |
  | `6d867050` | Primer instalador por clon (2026-11-07) | |
  | `228daf43` | Integración local (2026-11-09) | |
  | `a73f831a` | `main` dentro de `feat/desktop-launchers` (2026-11-11) | |
  | `dc7abde0` | #391 en `main` (2026-11-11) | |
  | `main` | El `main` de esa ejecución | |

  Si el commit de T27 no está en la tabla: Actions, «Windows desktop drill», «Run workflow», con
  `old_commit` igual a ese commit (corre solo ese), o en otra PC
  ([abajo](#ensayo-en-otra-pc-con-windows)). La misma ejecución arma un kit con `visit-kit.mjs` en
  una carpeta temporal e instala desde ella (`VISIT KIT INSTALLED`) y ensaya el paso K desde
  `dc7abde0` (o desde `old_commit`) en el job «laptop-kit». Sin `DRILL PASSED` para el commit de
  T27 no hay visita. Anotalo en «Datos de esta visita».
- [ ] **Disco externo** con espacio libre para dos copias de `%LOCALAPPDATA%\SIPGES` (tamaño de T27). Nunca
  una carpeta compartida ni sincronizada con la nube (OneDrive, Drive).
- [ ] **Este runbook impreso**, una birome y el cargador de la laptop.
- [ ] **La usuaria estará presente** con su teléfono (código MFA) durante unas dos horas.

### Ensayo en otra PC con Windows

El mismo ensayo que corre GitHub Actions en `windows-latest` (`.github/workflows/windows-desktop.yml`,
uno por commit candidato; a mano desde la pestaña Actions, con `old_commit` para uno solo) se puede correr en otra PC o cuenta de Windows, **nunca en
la laptop**. Solo usa datos inventados y una clave de firma descartable que crea y borra él mismo. En
orden: instala el clon viejo con `LOCALAPPDATA` en una carpeta temporal y lo abre con su `start.ps1`,
carga datos por la API y toma `snapshot.mjs`; construye y firma la versión N; hace el paso 3 de este
runbook (`Copy-Item`, `install.ps1 -Release … -State …`), el primer arranque del paso 4 y la
comparación del paso 5, y comprueba que la carpeta original no cambió; firma N+1 en
`SIPGES-app\releases`, pide la actualización por la API y vuelve a comparar; provoca una detención y
comprueba el código 3 y el mensaje.

Hace falta Node 24 o más, pnpm 12.11.2, Git y el puerto 8000 libre (SIPGES cerrado). Tarda: instala
dependencias dos veces y construye dos paquetes. En PowerShell, dentro del checkout definitivo:

```powershell
pnpm install --frozen-lockfile
node deploy\desktop\windows\drill.mjs --old-commit <commit de T27>
$LASTEXITCODE
```

Tenés que ver `DRILL PASSED` y `0`. Con `DRILL FAILED: …` no hay visita hasta corregirlo con su
prueba. Mientras corre cambia los accesos directos «SIPGES» de esa cuenta y al final los devuelve;
el `start.ps1` viejo abre Edge una vez. Deja `%TEMP%\sipges-drill-<hora>` (solo datos inventados) con
los registros en `logs\`, y los paquetes en `.data\desktop-packages`. Los scripts salen de
`git archive HEAD` como en el USB: un cambio sin commit no entra en el ensayo.

## 2. En la laptop

Todo se escribe en **Windows PowerShell** (menú Inicio, «Windows PowerShell»; no hace falta abrirlo como
administrador). Escribí los comandos como están, cambiando solo lo que va entre `< >`.

Para cerrar SIPGES **por completo** (lo pide varias veces): cerrá la ventana de SIPGES; abrí el
Administrador de tareas (Ctrl+Shift+Esc), y en «Detalles» finalizá cada `node.exe`. Después comprobá (⚠):

```powershell
try { Invoke-WebRequest -Uri http://127.0.0.1:8000/health -UseBasicParsing -TimeoutSec 2 | Out-Null; 'SIPGES sigue ABIERTO' } catch { 'SIPGES cerrado' }
```

Tiene que decir `SIPGES cerrado`.

### Paso K — Armar el kit en la laptop

El kit se construye y se firma en la laptop, desde un **segundo clon** en `C:\SIPGES-kit`. El clon
viejo (`<clon>`, el que abren los accesos directos) y `%LOCALAPPDATA%\SIPGES*` no se tocan: el kit se
niega a escribir ahí. Con la red de la casa.

- [ ] **Primero el respaldo**: hacé ahora el [paso 1](#paso-1--respaldo-en-el-disco-externo-t26) (no
  necesita el kit) y volvé acá. Si algo llena el disco mientras se arma el kit, los datos ya están a
  salvo.
- [ ] SIPGES cerrado (`SIPGES cerrado`, arriba) y la usuaria no lo está usando: el kit no se arma
  mientras ella trabaja.
- [ ] Carpeta del clon viejo: clic derecho en el acceso directo «SIPGES» del escritorio, Propiedades,
  Destino. Lo que va antes de `\deploy\desktop\windows\start.ps1` es `<clon>`; anotalo.
- [ ] Herramientas y espacio:

  ```powershell
  node --version
  pnpm --version
  git --version
  Get-PSDrive C | Format-List Free
  Test-Path C:\SIPGES-kit
  ```

  Node `v24` o más; pnpm `12.…`; git responde; `Free` con al menos 5 GB libres más lo que pide el
  paso 0 (cuatro veces `%LOCALAPPDATA%\SIPGES` más 2 GB); `Test-Path` dice `False`. Con Node menor que
  24 no hay visita (sección 1): **no instales ni actualices Node en la laptop**, la versión vieja de
  SIPGES corre con ese Node; parás acá y la laptop queda como está. Sin pnpm 12:
  `npm install -g pnpm@12.11.2` y una terminal nueva.
- [ ] El clon viejo **antes** del kit (anotá las dos salidas; `--no-optional-locks` evita que `git`
  escriba en él):

  ```powershell
  git -C "<clon>" log --oneline -1
  git -C "<clon>" --no-optional-locks status --short
  ```

- [ ] Segundo clon del commit definitivo, en su propia carpeta, y sus dependencias:

  ```powershell
  git clone https://github.com/Dreamcoder08/sipges.git C:\SIPGES-kit
  cd C:\SIPGES-kit
  git checkout --detach <commit definitivo>
  git status --short
  git log --oneline -1
  pnpm install --frozen-lockfile
  ```

  `git status --short` no imprime nada y `git log` muestra el commit definitivo. Si `git clone` o
  `pnpm install` fallan por la red, reintentá una vez; si vuelven a fallar, regla de corte del kit
  (abajo).
- [ ] Conectá el USB de la clave `K:` y armá el kit, todavía en `C:\SIPGES-kit`. El kit va a una
  carpeta aparte de la laptop:

  ```powershell
  New-Item -ItemType Directory C:\SIPGES-kit-salida
  node deploy\desktop\windows\visit-kit.mjs --version <versión> --key K:\sipges-clave-actualizaciones.pem --out C:\SIPGES-kit-salida
  $LASTEXITCODE
  ```

  Solo si tenés un segundo USB `F:` y `(Get-Volume -DriveLetter F).FileSystemType` dice `NTFS` (no
  `FAT32` ni `exFAT`), el kit puede ir a él:

  ```powershell
  node deploy\desktop\windows\visit-kit.mjs --version <versión> --key K:\sipges-clave-actualizaciones.pem --out F:\
  $LASTEXITCODE
  ```

  Construye el paquete, crea la clave en `K:` si no existe (o la reutiliza), firma la versión (notas
  «Versión definitiva de la visita») y escribe `SIPGES-visita\` con `release-<versión>\`,
  `sipges-scripts.zip`, `fingerprint.txt` y `LEEME.txt`. Tenés que ver `Release <versión> signed: …`,
  `Kit listo: …\SIPGES-visita`, la lista final y `0`.

  Antes de construir, se niega con `Error: …` y `1`, sin escribir nada. Lo único que puede borrar es
  el paquete **incompleto** que dejó un intento anterior fallido de esta misma versión en
  `C:\SIPGES-kit\.data\desktop-packages\sipges-<versión>` (lo dice: `Paquete incompleto de un
  intento anterior borrado: …`); nunca un paquete terminado ni nada fuera de esa carpeta. Si otra terminal
  todavía está construyendo esa versión, se niega («Hay otra construcción de la versión … en curso»)
  y no borra nada: **corré el kit en una sola terminal a la vez** y esperá a que termine.

  | Empieza con | Qué hacer |
  | --- | --- |
  | `Node.js … es anterior a 24` | No hay visita (sección 1): no instales ni actualices Node en la laptop; la versión vieja sigue como está. |
  | `Falta pnpm` / `pnpm … no sirve` | `npm install -g pnpm@12.11.2`, terminal nueva, repetí. |
  | `SIPGES está abierto` | Cerralo por completo (`SIPGES cerrado`) y repetí. |
  | `Falta espacio en …` | Usá `--out F:\` si estabas en la laptop, o liberá espacio (nunca en `%LOCALAPPDATA%\SIPGES*` ni en `<clon>`). |
  | `Los accesos directos «SIPGES» abren este clon` / `… dentro del clon viejo …` | Estás en el clon viejo o dentro: `cd C:\SIPGES-kit`. |
  | `… is inside the repository …` / `… overlap …` / `… SIPGES folder of %LOCALAPPDATA% …` | La clave o el kit apuntan a un lugar prohibido: usá exactamente los comandos de arriba. |
  | `this checkout has uncommitted changes` | En `C:\SIPGES-kit`, `git status --short` imprimió algo: regla de corte del kit. |
  | `… already exists; move it away first` | Ya hay un `SIPGES-visita` en `--out`: renombralo (`Rename-Item <ruta>\SIPGES-visita SIPGES-visita-fallida-1`) y repetí. |
  | `Ya hay un paquete terminado de la versión …` | Un intento anterior construyó el paquete y falló después. Borrá **solo** la carpeta que nombra el mensaje, con `cmd /c rmdir /s /q "<carpeta del mensaje>"` (no sigue enlaces, a diferencia de `Remove-Item -Recurse`), y repetí. |
  | `Hay otra construcción de la versión … en curso …` | Otra terminal está armando esa versión: esperá a que termine y repetí. Si ya no queda ninguna terminal con el kit (se cerró o se cortó a mitad, Windows le dio su número de proceso a otro programa, o ese número no se pudo leer), borrá **solo** la carpeta que nombra el mensaje, con la ruta tal como la imprime: `cmd /c rmdir /s /q "C:\SIPGES-kit\.data\desktop-packages\sipges-<versión>"`, y repetí. Nunca borres otra cosa: ni `.data`, ni `desktop-packages`, ni otra versión. |
  | `… no es un paquete que haya dejado builder.mjs …` / `… es un enlace o no es una carpeta …` | Algo ajeno ocupa ese lugar en `C:\SIPGES-kit\.data`: no lo borres a ciegas; regla de corte del kit. El mensaje propone revisarlo y borrarlo (o quitar el enlace) porque sirve también fuera de la visita; en la laptop no lo hagas: en un clon recién hecho ahí solo escribe el kit, y algo ajeno puede ser un enlace a otros datos. |

  Si falla **al construir** (antes de `Package created: …`), repetí el mismo comando: el kit borra
  solo ese paquete incompleto y vuelve a construir. Si falla **después** (al firmar o al escribir
  `SIPGES-visita`), primero renombrá `SIPGES-visita` como dice la tabla; al repetir, el kit se niega
  con `Ya hay un paquete terminado …`: borrá la carpeta que nombra y repetí. Un segundo fallo en el
  mismo punto: regla de corte del kit.
- [ ] **La clave** (Ed25519, PKCS#8 PEM) es la única con la que la laptop aceptará actualizaciones; si
  se pierde, no hay más actualizaciones sin reinstalar. Si el kit dice «La clave se creó ahora», hacé
  una segunda copia apenas puedas, en otro USB o en tu equipo al volver; nunca en la laptop, en el
  repositorio ni en la carpeta del kit. **Retirá el USB `K:` ahora.**
- [ ] **La huella**: anotá en «Datos de esta visita» la de `SIPGES-visita\fingerprint.txt` (la misma
  que imprimen el kit y, en el paso 3, el instalador).
- [ ] El clon viejo **después** del kit: los dos comandos de antes dan exactamente lo mismo que
  anotaste. Si no, regla de corte del kit.
- [ ] El kit no tiene datos ni secretos. Los pasos 0, 2, 3, 4 y 5 usan sus rutas (`LEEME.txt` las trae
  con la carpeta real); `snapshot.mjs` y `compare.mjs` salen de su `sipges-scripts.zip`. El paquete
  puede tener enlaces de carpeta: la versión se instala desde `release-<versión>` donde quedó, sin
  copiarla antes (en un USB, ⚠ NTFS no probado).

**Regla de corte del kit.** Si una negativa no se resuelve con lo que dice la tabla, si `git clone` o
`pnpm install` fallan dos veces, si el clon viejo cambió, o si una hora después de empezar el paso K
no viste `Kit listo`: **hoy no se instala nada**. La versión vieja sigue en uso tal como estaba (el
kit no tocó `<clon>` ni `%LOCALAPPDATA%\SIPGES`); el respaldo de `E:` queda guardado. `C:\SIPGES-kit`
y `C:\SIPGES-kit-salida` no tienen datos: pueden quedar y se borran en otra visita. Llevate la salida
del comando que falló (sección 4).

### Paso 0 — Preparar (no toca datos)

- [ ] `node --version` dice `v24` o más.
- [ ] `Test-Path "$env:LOCALAPPDATA\SIPGES-app"` y `Test-Path "$env:LOCALAPPDATA\SIPGES-datos"` dicen
  `False` los dos. Si alguno dice `True`, alguien ya instaló algo: no sigas, la laptop queda como estaba.
- [ ] `<clon>` es la carpeta anotada en el paso K.
- [ ] Espacio libre: `Get-PSDrive C | Format-List Free` tiene que superar cuatro veces el tamaño de
  `%LOCALAPPDATA%\SIPGES` más 2 GB (la copia de trabajo, las dos copias del primer arranque y el
  programa; es una estimación).
- [ ] Conectá el USB `F:` (si el kit está en él) y descomprimí los scripts en la laptop (⚠). La carpeta
  firmada se queda donde está:

  ```powershell
  New-Item -ItemType Directory "$env:LOCALAPPDATA\SIPGES-visita"
  Copy-Item F:\SIPGES-visita\sipges-scripts.zip "$env:LOCALAPPDATA\SIPGES-visita"
  Expand-Archive -LiteralPath "$env:LOCALAPPDATA\SIPGES-visita\sipges-scripts.zip" -DestinationPath "$env:LOCALAPPDATA\SIPGES-visita\sipges"
  Test-Path "$env:LOCALAPPDATA\SIPGES-visita\sipges\deploy\desktop\windows\install.ps1"
  ```

  Tiene que decir `True`. Dejá el USB conectado hasta terminar el paso 3.

  Para descomprimir y para el resto, el kit en `C:\SIPGES-kit-salida` funciona igual: cambiá `F:\SIPGES-visita`
  por `C:\SIPGES-kit-salida\SIPGES-visita`.

### Paso 1 — Respaldo en el disco externo (T26)

Se hace antes del paso K. Si la usuaria ya hizo hoy un respaldo comprobado, marcá este paso y anotá
sus números.

- [ ] Cerrá SIPGES por completo (arriba): `SIPGES cerrado`.
- [ ] Conectá el disco externo y copiá la carpeta completa:

  ```powershell
  Copy-Item -Recurse "$env:LOCALAPPDATA\SIPGES" "E:\SIPGES-<fecha>"
  ```

- [ ] Comprobá que la copia tiene los mismos archivos y bytes (⚠ `-Force` cuenta también los ocultos):

  ```powershell
  foreach ($c in "$env:LOCALAPPDATA\SIPGES", "E:\SIPGES-<fecha>") { $m = Get-ChildItem -Recurse -File -Force -LiteralPath $c | Measure-Object -Property Length -Sum; "$c  archivos: $($m.Count)  bytes: $($m.Sum)" }
  ```

  Tenés que ver dos líneas con los mismos números; anotalos. Si difieren, repetí la copia en una carpeta
  nueva (`E:\SIPGES-<fecha>-2`) agregando `-Force` al `Copy-Item`; si siguen distintos, no sigas.
- [ ] Expulsá el disco y guardalo lejos de la laptop. Contiene los datos, `data-key` y `admin-password`.

### Paso 2 — Versión vieja y conteos

- [ ] Versión instalada:

  ```powershell
  cd "<clon>"
  git log --oneline -1
  git --no-optional-locks status --short
  ```

  El commit tiene que ser el de T27 (el que se ensayó con `rehearse.mjs`). Si es otro, no sigas: el
  traslado no se ensayó desde ese commit. Anotá también si `git --no-optional-locks status --short`
  imprimió algo.
- [ ] Abrí SIPGES desde el acceso directo de siempre. Edge se abre en `http://localhost:8000` y la
  usuaria entra. Cerrá solo la ventana: el servidor sigue encendido.
- [ ] Conteos de la versión vieja. La persona que tiene la contraseña de `admin` la escribe cuando se pide
  `Contraseña:`, y un código actual del autenticador en `Código MFA (vacío si no tiene):`:

  ```powershell
  node "$env:LOCALAPPDATA\SIPGES-visita\sipges\deploy\desktop\migration\snapshot.mjs" --url http://127.0.0.1:8000 --out "$env:LOCALAPPDATA\SIPGES-visita\sipges-antes.json"
  ```

  Tenés que ver `SIPGES snapshot at …`, `Projects: N`, una línea `project N [hash]: records …, links
  …, uploads …, audit …` por proyecto, `Accounts: N` y `Written: …\sipges-antes.json`. Solo números y
  hashes cortos. Si una línea dice `(not fully checked)` (en `records`, `uploads` o `audit`) o sale
  `Error: …`, no sigas.
  Solo si `admin` nunca cambió su contraseña, `--password-file "$env:LOCALAPPDATA\SIPGES\admin-password"`
  evita escribirla. (El README de migración guarda este archivo en el Escritorio; aquí va a
  `SIPGES-visita` porque el Escritorio puede estar sincronizado con OneDrive.)

### Paso 3 — Instalar la versión definitiva al lado de la vieja

- [ ] Cerrá SIPGES por completo: `SIPGES cerrado`.
- [ ] Contá la carpeta original **ahora**, ya cerrada. Estos números prueban después que nadie la tocó;
  anotalos en «Datos de esta visita»:

  ```powershell
  foreach ($c in "$env:LOCALAPPDATA\SIPGES") { $m = Get-ChildItem -Recurse -File -Force -LiteralPath $c | Measure-Object -Property Length -Sum; "$c  archivos: $($m.Count)  bytes: $($m.Sum)" }
  ```

- [ ] Copia de trabajo de los datos (la versión nueva usa esta; la original queda para la vieja):

  ```powershell
  Copy-Item -Recurse "$env:LOCALAPPDATA\SIPGES" "$env:LOCALAPPDATA\SIPGES-datos"
  foreach ($c in "$env:LOCALAPPDATA\SIPGES", "$env:LOCALAPPDATA\SIPGES-datos") { $m = Get-ChildItem -Recurse -File -Force -LiteralPath $c | Measure-Object -Property Length -Sum; "$c  archivos: $($m.Count)  bytes: $($m.Sum)" }
  ```

  Las dos líneas, iguales.
- [ ] Guardá los accesos directos viejos (⚠). El instalador los cambia **en el acto** para que abran la
  versión nueva; con esta copia se devuelven en la regla de corte:

  ```powershell
  Copy-Item (Join-Path ([Environment]::GetFolderPath('Programs')) 'SIPGES.lnk') "$env:LOCALAPPDATA\SIPGES-visita\SIPGES-menu.lnk"
  Copy-Item (Join-Path ([Environment]::GetFolderPath('Desktop')) 'SIPGES.lnk') "$env:LOCALAPPDATA\SIPGES-visita\SIPGES-escritorio.lnk"
  ```

  Si alguno da error porque no existe, anotá cuál; la regla de corte tiene otra salida.
- [ ] Instalá. El comando lleva **siempre** `-State "$env:LOCALAPPDATA\SIPGES-datos"`: sin `-State`, el
  instalador usa la carpeta original `%LOCALAPPDATA%\SIPGES` y el primer arranque la migraría en su
  lugar, dejando la versión vieja sin sus datos. Antes de Enter, leé que esté:

  ```powershell
  powershell -ExecutionPolicy Bypass -File "$env:LOCALAPPDATA\SIPGES-visita\sipges\deploy\desktop\windows\install.ps1" -Release F:\SIPGES-visita\release-<versión> -State "$env:LOCALAPPDATA\SIPGES-datos"
  ```

  Tenés que ver, en este orden:
  - `Trusting the update key that signed this release (SHA-256 …).` La huella **tiene que ser igual**
    a la anotada en el paso K (la de `SIPGES-visita\fingerprint.txt`). Si no lo es, regla de corte.
  - `Installed <versión>`
  - `SIPGES está instalado. Ábrelo desde el menú Inicio o el escritorio.` (todavía no lo abras)
  - `Instalación: …\SIPGES-app. …`, `Usuario administrador: admin. Contraseña: …\SIPGES-datos\admin-password`
  - `Se conservó la carpeta de datos existente …\SIPGES-datos. …` y `Respáldala tú también antes de
    abrir SIPGES.` (el respaldo del paso 1 tiene el mismo contenido).

  Si en cambio aparece `SIPGES está abierto en este equipo: …`, cerralo por completo y repetí.
  `… no es una versión firmada …`, `La carpeta de datos … tiene una base de datos pero falta su …`,
  `Esta instalación usa la carpeta de datos …` o `Falló: …`: regla de corte.
  `Hay una actualización de SIPGES pendiente o detenida (…); no se cambió nada. No borres ni muevas
  ninguna carpeta de SIPGES. …` (y `1`): alguien ya instaló y empezó una actualización en esta
  cuenta. No repitas el comando, no borres ni muevas nada: regla de corte (⚠ F4, no probado en
  Windows).
  `La carpeta de datos … es un enlace o una unión (junction): …` o `-State … lleva a la carpeta de
  datos original …` (y `1`; ⚠ el primero no probado en Windows, el segundo lo ejecuta el drill de
  Windows, paso 3): el `-State` no es la copia real y no se cambió
  nada. Revisá que el comando diga `-State "$env:LOCALAPPDATA\SIPGES-datos"` y que `SIPGES-datos`
  sea la carpeta que copiaste arriba con `Copy-Item`, nunca un enlace a la original; corregí y
  repetí. Si no queda claro: regla de corte.
- [ ] Confirmá la carpeta de datos: `Get-Content "$env:LOCALAPPDATA\SIPGES-app\install.json"` muestra
  `stateDir` terminado en `SIPGES-datos`. Si termina en `\SIPGES` o en otra cosa: **no hagas el paso
  4 ni abras SIPGES** (el primer arranque migraría esa carpeta); regla de corte. Retirá el USB `F:`
  si lo usaste (la versión ya se copió dentro de `SIPGES-app\versions`).

### Paso 4 — Primer arranque sobre la copia (traslado T33)

Se hace en la terminal para no depender de la espera de 300 segundos del acceso directo.

- [ ] Ejecutá:

  ```powershell
  node "$env:LOCALAPPDATA\SIPGES-app\versions\<versión>\updater\update.mjs" --install "$env:LOCALAPPDATA\SIPGES-app" --first-start
  $LASTEXITCODE
  ```

  Tenés que ver `First start of <versión> done. Pre-update copy: …\SIPGES-datos.pre-update-<hora>-first-start-<versión>`
  y después `0`. Al lado de `SIPGES-datos` aparecen esa copia y `SIPGES-datos.rehearsal-<hora>-<versión>`:
  no las borres, tienen los datos y la clave.
  Si sale `Error: …` o un número distinto de `0`: regla de corte. La carpeta original
  `%LOCALAPPDATA%\SIPGES` no se abrió nunca: la versión vieja sigue con ella. Lo que queda en
  `SIPGES-datos` depende del número (anotalo):
  - `1` (se negó; por ejemplo falta `data-key`): no tocó nada.
  - `2` (falló y volvió atrás): `SIPGES-datos` quedó como estaba; si ya se había migrado, se
    restauró de la copia `SIPGES-datos.pre-update-…` y la cambiada quedó al lado como
    `SIPGES-datos.failed-…`.
  - `3` (vuelta atrás incompleta): `SIPGES-datos` puede quedar **a medio migrar o a medio
    restaurar**; los datos de antes están en `SIPGES-datos.pre-update-<hora>-first-start-<versión>`.
    **No vuelvas a ejecutar `install.ps1`**, ni `update.mjs` (`--first-start` o `--recover`), ni
    abras la versión nueva: regla de corte ya, y no borres nada al lado de `SIPGES-datos`.
- [ ] Abrí SIPGES desde el acceso directo (ya apunta a la versión nueva). Edge se abre antes de 300 segundos (normalmente en menos de 90).
  Si en cambio aparece un cuadro: regla de corte. Si el primer arranque falla desde el acceso
  directo, el cuadro dice «SIPGES se cerró al arrancar. Revisa …\launcher.log.» (el texto «SIPGES no
  se inició: la versión nueva no pudo abrir los datos existentes …» queda **solo** en
  `launcher.log`, no en el cuadro); con una vuelta atrás incompleta (código 3) el cuadro dice
  «SIPGES no se inició: una actualización falló y sus datos no se pudieron restaurar. …». También
  puede decir «SIPGES no arrancó en 300 segundos. Revisa …». Ese aviso **no** detiene el lanzador, que
  sigue en segundo plano: antes de reintentar, cerralo (Administrador de tareas, proceso `node`
  de SIPGES) y mirá `launcher.log`.

### Paso 5 — Comparar

- [ ] Esperá a que el autenticador muestre un código **nuevo** (el servidor rechaza uno ya usado) y ejecutá:

  ```powershell
  node "$env:LOCALAPPDATA\SIPGES-visita\sipges\deploy\desktop\migration\compare.mjs" --before "$env:LOCALAPPDATA\SIPGES-visita\sipges-antes.json" --url http://127.0.0.1:8000
  $LASTEXITCODE
  ```

  Tenés que ver `Sign-in: ok (password and MFA code)`; `Managed install: version <versión>`, con la
  versión de hoy (prueba que responde la versión nueva y no la vieja, que también contesta en el
  puerto 8000); por cada proyecto, `project N [<hash>]` y debajo solo estas líneas, en este orden:

  | Línea | Cuándo aparece |
  | --- | --- |
  | `<módulo>: N -> N, every field identical` | Una por módulo con registros; un proyecto sin registros no tiene ninguna. |
  | `links: N -> N, identical` | Siempre, también `links: 0 -> 0, identical`. |
  | `uploads: N -> N, content <hash>… identical` o `uploads: 0 -> 0, none` | Siempre; `none` es un proyecto sin archivos subidos. |
  | `export <tabla>: N -> N, identical` | Una por tabla de la exportación con filas (`attachments`, `record_links`, `record_versions`, …); un proyecto vacío no tiene ninguna. |
  | `audit: N -> N, N kept unchanged` o `audit: 0 -> 0` | Siempre; sin `kept unchanged` cuando el proyecto no tenía entradas antes. A las dos puede seguir `, added: #<id> <módulo>/<acción>, …`, y entonces el segundo número es mayor: son entradas nuevas desde el conteo, no diferencias. |

  Las dos cifras de cada línea son iguales, salvo en `audit` con `added`. Después,
  `Accounts: N -> N, identical`; `Isolation: … no record or upload of one project visible in another`;
  al final `RESULT: no difference` (puede seguir `(N audit entries added, listed above)`) y `0`. Todas
  esas formas son correctas: no apliques la regla de corte por la forma de una línea de proyecto; el
  veredicto de la comparación es la última línea `RESULT:` y el `$LASTEXITCODE`. Una línea con
  `missing`, `new`, `differs`, `changed` o `problems` es una diferencia, y el `RESULT` ya no es
  `no difference`. Ninguna línea puede decir `not fully checked` ni `not checked`
  (por ejemplo `records: not fully checked (…)`, `export: not checked (…)` o `Accounts: not checked (…)`):
  cada una es una parte que no se pudo comparar, y el `RESULT` ya no es `no difference`. Cómo leer cada línea:
  [migration/README.md](../../deploy/desktop/migration/README.md#reading-the-comparison).
  Si dice `RESULT: not compared (not the managed install)` y `2`, no se comparó nada: responde la
  versión vieja (quedó abierta y el acceso directo la reutilizó). Cerrá SIPGES por completo
  (`SIPGES cerrado`), abrilo desde el acceso directo, esperá otro código MFA y repetí una sola vez.
  Si vuelve a decirlo, o dice `RESULT: not compared (installed version not readable)` o
  `RESULT: not compared (no project scope for this account)` (la cuenta no es `admin` o no tiene
  proyectos), o la versión de `Managed install` no es la de hoy: regla de corte.
  También `2`, y regla de corte, sin reintento: `RESULT: not compared (redirect: …)` (algo en el
  puerto respondió con una redirección; la comparación nunca la sigue),
  `RESULT: not compared (the server could not be reached or the connection dropped: …)` (SIPGES no
  respondió o cortó la conexión) y `RESULT: not compared (error: …)`. Las tres vienen después de un
  `Error: …`; las líneas anteriores comparan solo una parte. Si se corta en las pruebas de
  aislamiento, ya pueden verse líneas `identical` y estar escrito el archivo de `--out`: lo único
  que vale es la última línea `RESULT:` y el `$LASTEXITCODE`. Si SIPGES deja de responder sin
  cortar, la comparación puede quedar sin escribir nada hasta unos 5 minutos antes de decir
  `not compared` y `2`.
  Cualquier otro `RESULT` (`sign-in failed`, que sigue a `Sign-in failed (status …)`;
  `N differences`; `not fully checked`; `not compared`) o un número distinto de `0`: regla de corte.
- [ ] **Lo que la comparación no cubre** (verificado en el código; está en
  [migration/README.md](../../deploy/desktop/migration/README.md#reading-the-comparison)). Un
  `RESULT: no difference` no prueba:
  - de cada registro, su marca de clasificación (`marking`) ni su fecha de creación (`created_at`):
    se comparan sus campos y su fecha de modificación;
  - tablas que no están en la exportación del proyecto: `irsa_configs`, `irsa_snapshots`,
    `media_feeds`, `proposal_decisions`, `link_evidence_history`, `grants`, `api_keys`,
    `integration_channels`, las etiquetas de los proyectos (`tenants`) y estado técnico
    (`record_embeddings`, `ingest_receipts`, `notification_reads`, `automation_cursors`,
    `digital_signal_dedup_locks`, sesiones, intentos fallidos de entrada, suscripciones y envíos push);
  - las contraseñas y los secretos MFA de las cuentas que no son `admin` (la de `admin` la prueba el
    inicio de sesión); de cada cuenta se compara nombre, rol, si está activa, alta y vínculo Google;
  - los proyectos a los que `admin` no tiene acceso.

  Por eso la usuaria revisa a mano el paso siguiente y, si usa IRSA, fuentes de medios o cuentas
  de otras personas, que abran como antes.
- [ ] La usuaria elige y abre, en la versión nueva, **diez registros** y **tres archivos subidos**. Cada uno
  abre y se ve como lo recuerda (marcá sin escribir cuál):
  Registros ☐ ☐ ☐ ☐ ☐ ☐ ☐ ☐ ☐ ☐ — Archivos ☐ ☐ ☐

### Paso 6 — La usuaria trabaja diez minutos

- [ ] Cierra sesión y vuelve a entrar con su contraseña y un código MFA.
- [ ] Trabaja diez minutos en sus tareas de siempre. Que anote en **su** papel (no en esta hoja) lo que
  cargue o cambie: si después se aplica la regla de corte, eso hay que cargarlo de nuevo en la versión
  vieja, porque quedó solo en `SIPGES-datos`.
- [ ] Nada falló, nada se vio raro. Si algo falla: regla de corte.

### Paso 7 — El acceso directo queda en la versión nueva

El instalador ya apuntó los accesos directos a la versión nueva en el paso 3; este paso confirma que se
quedan así.

- [ ] Comprobá el destino (⚠):

  ```powershell
  foreach ($f in [Environment]::GetFolderPath('Programs'), [Environment]::GetFolderPath('Desktop')) { (New-Object -ComObject WScript.Shell).CreateShortcut((Join-Path $f 'SIPGES.lnk')).Arguments }
  ```

  Las dos líneas terminan en `\SIPGES-app\start.ps1"`.
- [ ] Cerrá SIPGES por completo y abrilo desde el menú Inicio: abre y la usuaria entra.
- [ ] Durante 30 días **no se borra nada**: ni `<clon>`, ni `%LOCALAPPDATA%\SIPGES`, ni el respaldo de `E:`,
  ni `SIPGES-visita` (accesos directos viejos y `sipges-antes.json`), ni las copias al lado de
  `SIPGES-datos`.
- [ ] Explicale cómo abrir la versión vieja si hiciera falta consultarla:
  1. Cerrá SIPGES por completo (`SIPGES cerrado`). Importante: cada acceso directo reutiliza el
     servidor que ya responde en el puerto 8000, así que sin este paso «la vieja» mostraría la nueva, y
     al revés.
  2. `powershell -ExecutionPolicy Bypass -File "<clon>\deploy\desktop\windows\start.ps1"`
  3. Al terminar, cerrarla por completo antes de volver a abrir la nueva. Lo que se cargue en una no
     aparece en la otra: la vieja es solo para consultar.

### Paso 8 — El aviso de actualización y el respaldo

- [ ] **Aviso** (T8). Mostrale la foto del ensayo: un administrador ve «Nueva versión de SIPGES» con
  «Qué cambió», «Actualizar» y «Ahora no». «Ahora no» lo oculta hasta el próximo arranque. **Nada se
  instala sin su clic en «Actualizar».** No se deja ninguna versión nueva en la laptop durante la visita.
- [ ] **Respaldo** (T11), hecho una vez juntos ahora. Su carpeta de datos es desde hoy
  `%LOCALAPPDATA%\SIPGES-datos`:
  1. Cerrar SIPGES por completo (`SIPGES cerrado`).
  2. Ver la versión: `Get-Content "$env:LOCALAPPDATA\SIPGES-app\current.json"`.
  3. `Copy-Item -Recurse "$env:LOCALAPPDATA\SIPGES-datos" "E:\SIPGES-<fecha>-<versión>"`
  4. `foreach ($c in "$env:LOCALAPPDATA\SIPGES-datos", "E:\SIPGES-<fecha>-<versión>") { $m = Get-ChildItem -Recurse -File -Force -LiteralPath $c | Measure-Object -Property Length -Sum; "$c  archivos: $($m.Count)  bytes: $($m.Sum)" }`
     — los mismos números en las dos líneas.
  5. Expulsar el disco y volver a abrir SIPGES.
- [ ] Anotá la fecha de la visita en T34 de `closure-roadmap.md` al volver.

## 3. Regla de corte

Se aplica ante **cualquiera** de estas cosas: una diferencia o un `RESULT` distinto de `no difference` en el
paso 5 (incluido `not compared`, salvo el único reintento que dice ese paso); un inicio de sesión fallido (pasos 2, 5 o 6); un `Error: …` del primer arranque; una huella que no
coincide; un cuadro «SIPGES no se inició: …» o cualquier otro mensaje de error de la versión nueva.
Entonces **la versión vieja sigue en uso y la laptop queda como estaba**. No intentes reparar nada en la
visita: se lleva los registros (sección 4) y se resuelve en casa.

- [ ] Cerrá SIPGES por completo: `SIPGES cerrado`.
- [ ] Devolvé los accesos directos viejos (⚠):

  ```powershell
  Copy-Item "$env:LOCALAPPDATA\SIPGES-visita\SIPGES-menu.lnk" (Join-Path ([Environment]::GetFolderPath('Programs')) 'SIPGES.lnk') -Force
  Copy-Item "$env:LOCALAPPDATA\SIPGES-visita\SIPGES-escritorio.lnk" (Join-Path ([Environment]::GetFolderPath('Desktop')) 'SIPGES.lnk') -Force
  ```

  Si en el paso 3 no existía alguno, recrealos como lo hace el instalador por clon (⚠; `<clon>` es la
  carpeta anotada):

  ```powershell
  $clon = '<clon>'
  $shell = New-Object -ComObject WScript.Shell
  foreach ($folder in [Environment]::GetFolderPath('Programs'), [Environment]::GetFolderPath('Desktop')) {
      $link = $shell.CreateShortcut((Join-Path $folder 'SIPGES.lnk'))
      $link.TargetPath = "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe"
      $link.Arguments = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$clon\deploy\desktop\windows\start.ps1`""
      $link.WorkingDirectory = $clon
      $link.IconLocation = "$clon\deploy\desktop\sipges.ico"
      $link.Description = 'SIPGES en este equipo'
      $link.Save()
  }
  ```

- [ ] Con el comando del paso 7 las dos líneas terminan en `\deploy\desktop\windows\start.ps1"` del clon.
- [ ] Confirmá que la carpeta original no se tocó: el conteo del paso 3 da **los mismos** archivos y bytes
  anotados, y en `<clon>` `git log --oneline -1` y `git --no-optional-locks status --short` dicen lo
  mismo que en el paso 2 (`--no-optional-locks` evita que `git` reescriba el índice del clon viejo).

  ```powershell
  foreach ($c in "$env:LOCALAPPDATA\SIPGES") { $m = Get-ChildItem -Recurse -File -Force -LiteralPath $c | Measure-Object -Property Length -Sum; "$c  archivos: $($m.Count)  bytes: $($m.Sum)" }
  ```

  Si no coinciden, no abras la versión vieja: restaurá el respaldo del paso 1 como dice
  [Respaldar y restaurar](../../deploy/desktop/README.es.md#respaldar-y-restaurar), pasos 5 a 8.
- [ ] Abrí SIPGES desde el acceso directo: es la versión vieja, la usuaria entra y ve sus datos. Si trabajó
  en la nueva en el paso 6, carga de nuevo lo que anotó.
- [ ] No borres `SIPGES-app`, `SIPGES-datos` ni las copias a su lado: tienen los datos y la clave, guardalos
  como un respaldo más. Juntá los registros (sección 4).

## 4. Si algo falla

**Qué mensaje significa qué**

| Mensaje | Qué pasó |
| --- | --- |
| Cuadro «SIPGES se cerró al arrancar. Revisa …\launcher.log.», y en `launcher.log` «SIPGES no se inició: la versión nueva no pudo abrir los datos existentes. Sus datos no se tocaron. …» | El primer arranque falló y volvió atrás; `SIPGES-datos` quedó como estaba. Ese texto no aparece en el cuadro: está solo en `launcher.log`. Regla de corte. |
| «SIPGES no se inició: … Restaure la copia de seguridad <copia> o contacte con soporte.» | Detención: una actualización falló y ni su vuelta atrás terminó. SIPGES no arranca sobre esos datos. |
| «SIPGES no arrancó en 300 segundos. Revisa …\launcher.log.» / «SIPGES no arrancó. Revisa …» / «SIPGES se cerró al arrancar. Revisa …» | Versión nueva: mirá `launcher.log`. |
| «El servidor no arrancó en 90 segundos. Revisa …\api.log.» / «El servidor se cerró al arrancar. …» | Versión vieja: mirá `api.log`. |
| «Hay una actualización de SIPGES pendiente o detenida (…); no se cambió nada. No borres ni muevas ninguna carpeta de SIPGES. …» (de `install.ps1`, código 1) | Ya hay una instalación gestionada con una actualización a medias (`update-journal.json`). En la visita: regla de corte. Después: la salida documentada de una detención, abajo. |
| `--recover` se niega con código 3 pidiendo apartar la carpeta de datos recreada | La carpeta de datos se volvió a crear después de la detención: renombrala sin borrarla y repetí `--recover` (paso 2 de abajo). |

**Dónde están los registros**

| Archivo | Qué guarda |
| --- | --- |
| `%LOCALAPPDATA%\SIPGES-app\launcher.log` | Arranques de la versión nueva, la comprobación de versiones y el mensaje de detención |
| `%LOCALAPPDATA%\SIPGES-app\update.log` | Instalación, primer arranque, actualizaciones y vueltas atrás (una línea JSON cada uno) |
| `%LOCALAPPDATA%\SIPGES-app\update-boot.log` | Las pruebas de arranque del primer arranque y de cada actualización |
| `%LOCALAPPDATA%\SIPGES\api.log` | El servidor de la versión vieja |

**La salida documentada de una detención** (después de la visita, si una actualización se detiene; no en
la visita, donde se aplica la regla de corte). `<versión>` es la que dice `current.json`:

1. No borres nada.
2. `node "$env:LOCALAPPDATA\SIPGES-app\versions\<versión>\updater\update.mjs" --install "$env:LOCALAPPDATA\SIPGES-app" --recover`
   — si imprime `Recovered: rolled back to …`, abrí SIPGES. Si en cambio se niega con `Error: …` y
   `3` porque la carpeta de datos se volvió a crear después de la detención, el mensaje pide apartar
   esa carpeta recreada: renombrala (por ejemplo `SIPGES-datos` → `SIPGES-datos.recreada`, sin
   borrarla) y repetí este mismo paso 2.
3. Si no: renombrá la carpeta dañada (`%LOCALAPPDATA%\SIPGES-datos` → `SIPGES-datos.danada`) y copiá en su
   lugar la copia que nombra el mensaje, o tu propio respaldo.
4. `node "$env:LOCALAPPDATA\SIPGES-app\versions\<versión>\updater\update.mjs" --install "$env:LOCALAPPDATA\SIPGES-app" --recover --accept-restored-state`
   — imprime `Accepted the restored state folder; current version …`. Se niega mientras la carpeta falta o
   está vacía.
5. Abrí SIPGES.

Códigos de salida de `update.mjs` (`$LASTEXITCODE`): 0 hecho, 1 rechazado, 2 falló y volvió atrás,
3 vuelta atrás incompleta. Detalle: [Si una actualización se detiene a medias](../../deploy/desktop/README.es.md#si-una-actualización-se-detiene-a-medias).

**Qué llevarse para revisar en casa**

- [ ] Solo los registros, copiados al USB `F:` conectado de nuevo, o sin él a una carpeta aparte del USB
  `K:` (cambiá `F:` por `K:`). Los que no existan dan un error que podés ignorar:

  ```powershell
  New-Item -ItemType Directory "F:\registros-<fecha>" | Out-Null
  Copy-Item "$env:LOCALAPPDATA\SIPGES-app\launcher.log", "$env:LOCALAPPDATA\SIPGES-app\update.log", "$env:LOCALAPPDATA\SIPGES-app\update-boot.log", "$env:LOCALAPPDATA\SIPGES\api.log" "F:\registros-<fecha>"
  ```

- [ ] Una foto del cuadro de mensaje y la salida del comando que falló (solo números y hashes).
- [ ] **Nunca** te lleves ni envíes `SIPGES`, `SIPGES-datos`, ninguna carpeta `.pre-update-…`,
  `.rehearsal-…` o `.failed-…`, `data-key`, `admin-password`, `sipges-antes.json` (con su sal se puede
  confirmar un dato adivinado) ni el respaldo. Leé los registros antes de compartirlos y hacelo por un
  canal privado.

## 5. Después de la visita

- **30 días**: se conservan el respaldo de `E:`, `%LOCALAPPDATA%\SIPGES` con `<clon>` (la versión vieja),
  `SIPGES-visita` y las copias al lado de `SIPGES-datos`. `C:\SIPGES-kit` y `C:\SIPGES-kit-salida` no
  tienen datos ni la clave. Ninguna se borra sola; pasado ese plazo se decide
  qué guardar. Todas contienen los datos y la clave: se tratan como un respaldo. Cada arranque anota en
  `SIPGES-app\launcher.log` cuántas copias hay y cuánto ocupan (`"stateCopies"` en la línea `started`).
  Para verlas y, después de un respaldo, borrar las de más de 30 días (nunca borra la copia previa a la
  actualización más reciente, y se niega si una actualización quedó a medias):

  ```powershell
  node "$env:LOCALAPPDATA\SIPGES-app\versions\<versión>\updater\update.mjs" --install "$env:LOCALAPPDATA\SIPGES-app" --copies
  node "$env:LOCALAPPDATA\SIPGES-app\versions\<versión>\updater\update.mjs" --install "$env:LOCALAPPDATA\SIPGES-app" --remove-copies-older-than 30
  ```
- **Cómo llegan las actualizaciones**: se construye y firma en Windows una versión mayor con **la misma
  clave** y sus propias notas, y su carpeta se copia dentro de `%LOCALAPPDATA%\SIPGES-app\releases`. En el siguiente arranque la usuaria (administradora) ve
  «Nueva versión de SIPGES». Nada se descarga ni se instala sin su clic en «Actualizar». Una carpeta dañada,
  incompleta o firmada con otra clave no se ofrece. Cada actualización deja
  `SIPGES-datos.pre-update-<hora>-<de>-to-<a>` al lado de la carpeta. Cómo viaja la carpeta firmada hasta la
  laptop (USB u otro medio) está por decidir; no tiene secretos. En PowerShell, dentro de un clon limpio
  del commit nuevo (el kit del paso K es solo para la visita):

  ```powershell
  node deploy\desktop\package\builder.mjs --version <versión> --out .data\desktop-packages\sipges-<versión>
  $LASTEXITCODE
  node deploy\desktop\updater\release.mjs --package .data\desktop-packages\sipges-<versión> --out F:\release-<versión> --key K:\sipges-clave-actualizaciones.pem --notes "<qué cambió>"
  ```

  Firmá con `release.mjs` solo un paquete que `builder.mjs` (o el kit) terminó con `0` (el
  `$LASTEXITCODE` de arriba, después de `Package created: …`): `release.mjs` no comprueba que el
  paquete esté terminado y firmaría también uno a medias.
- **Respaldo**: el del paso 8, siempre antes de pulsar «Actualizar» y con la frecuencia que acuerden.
  Nunca en una carpeta compartida o sincronizada con la nube. Para restaurar:
  [Respaldar y restaurar](../../deploy/desktop/README.es.md#respaldar-y-restaurar), pasos 5 a 8 (la carpeta
  de datos es `%LOCALAPPDATA%\SIPGES-datos`).
