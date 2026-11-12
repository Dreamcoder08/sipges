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

Todo lo de Windows se revisó solo leyendo los scripts. El traslado, la actualización, la detención y el
respaldo se probaron de punta a punta **solo en Linux** con datos inventados. El ensayo de la sección 1 es
la primera prueba en Windows de todo esto. Lo marcado con ⚠ además no está en ningún README: lo agrega este
runbook y no se ejecutó en ningún sistema.

| Qué | Estado |
| --- | --- |
| `install.ps1 -Release … -State …`, `start-managed.ps1`, el cuadro de mensaje de detención | Solo revisión estática |
| `update.mjs --first-start` sobre NTFS, `snapshot.mjs` y `compare.mjs` en PowerShell 5.1 | Solo Linux |
| `builder.mjs` y `release.mjs` en Windows | Nunca ejecutados en Windows |
| ⚠ Llevar los scripts como `.zip` (`git archive`, `Expand-Archive`) | No probado |
| ⚠ Guardar y devolver los accesos directos (`.lnk`) | No probado |
| ⚠ Calcular la huella de la clave, crear la clave, contar archivos con `-Force`, comprobar «SIPGES cerrado» | No probado en Windows |

## Datos de esta visita

En los comandos, `E:` es el disco externo del respaldo, `F:` es el USB de la visita y `K:` el USB de la
clave. Si Windows les da otras letras, cambialas en cada comando.

| Dato | Valor |
| --- | --- |
| Fecha de la visita (`<fecha>`, por ejemplo `2026-12-05`) | |
| Versión definitiva (`<versión>`, por ejemplo `1.0.0`) | |
| Commit definitivo (`git log --oneline -1` al construir) | |
| Huella SHA-256 de la clave (anotada en casa) | |
| Commit de la instalación vieja (respuesta T27 y paso 2) | |
| Carpeta del clon viejo (`<clon>`, paso 0) | |
| Respaldo en `E:`: archivos / bytes (paso 1) | |
| `%LOCALAPPDATA%\SIPGES` al cerrar SIPGES: archivos / bytes (paso 3) | |
| Fecha del ensayo en otro Windows (sección 1) | |

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

  Tenés que ver `REHEARSAL PASSED` y `RESULT: no difference` en cada comparación.
- [ ] **Clave de firma.** Es un archivo Ed25519 (PKCS#8 PEM) en el USB `K:`, con una segunda copia guardada
  en otro lugar: la clave que firma esta versión es la única con la que la laptop aceptará
  actualizaciones; si se pierde, no hay más actualizaciones sin reinstalar. Nunca va al repositorio,
  al USB de la visita ni a la laptop. Si todavía no existe ninguna (⚠ no está en los README y no se
  probó; no la crees si ya firmaste algo con una):

  ```powershell
  node -e "const c=require('crypto');require('fs').writeFileSync(process.argv[1],c.generateKeyPairSync('ed25519').privateKey.export({type:'pkcs8',format:'pem'}),{flag:'wx'})" K:\sipges-clave-actualizaciones.pem
  ```

- [ ] **Construir y firmar en Windows** (otro equipo o tu propio Windows, nunca la laptop). `builder.mjs`
  se niega a construir para otro sistema (`Cross-builds are not supported`), así que se hace en Windows.
  En PowerShell, dentro del checkout definitivo:

  ```powershell
  git status --short
  git log --oneline -1
  pnpm install --frozen-lockfile
  New-Item -ItemType Directory F:\SIPGES-visita
  node deploy\desktop\package\builder.mjs --version <versión> --out .data\desktop-packages\sipges-<versión>
  node deploy\desktop\updater\release.mjs --package .data\desktop-packages\sipges-<versión> --out F:\SIPGES-visita\release-<versión> --key K:\sipges-clave-actualizaciones.pem --notes "Versión definitiva"
  ```

  `git status --short` no imprime nada (el paquete sale exactamente del commit). `release.mjs` termina
  con `Release <versión> signed: F:\SIPGES-visita\release-<versión>`. **Retirá el USB `K:` enseguida.**
  El paquete puede tener enlaces de carpeta; por eso la carpeta firmada se escribe directo en el USB, que
  conviene que esté formateado en NTFS (⚠ supuesto no probado), y en la laptop se instala desde el USB sin
  copiarla antes.
- [ ] **Huella de la clave** (⚠ calcula lo mismo que imprime el instalador; probado solo en Linux).
  Anotala en «Datos de esta visita»:

  ```powershell
  node -e "const c=require('crypto');console.log(c.createHash('sha256').update(c.createPublicKey(require('fs').readFileSync(process.argv[1])).export({type:'spki',format:'der'})).digest('hex'))" F:\SIPGES-visita\release-<versión>\package\update-public-key.pem
  ```

- [ ] **Scripts del mismo commit en el USB** (⚠). El instalador, `snapshot.mjs` y `compare.mjs` solo
  necesitan Node; viajan como un `.zip` de `deploy/desktop`, sin el resto del repositorio:

  ```powershell
  git archive --format=zip -o F:\SIPGES-visita\sipges-scripts.zip HEAD deploy/desktop
  ```

  El USB queda con `F:\SIPGES-visita\release-<versión>\` (`release.json`, `release.sig`, `package\`) y
  `F:\SIPGES-visita\sipges-scripts.zip`. No contiene datos ni secretos.
- [ ] **Ensayo completo en otra cuenta de Windows o en otro equipo**, nunca en la laptop, con el mismo USB y
  datos inventados. Fecha: ____________
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
- [ ] **Disco externo** con espacio libre para dos copias de `%LOCALAPPDATA%\SIPGES` (tamaño de T27). Nunca
  una carpeta compartida ni sincronizada con la nube (OneDrive, Drive).
- [ ] **Este runbook impreso**, una birome y el cargador de la laptop.
- [ ] **La usuaria estará presente** con su teléfono (código MFA) durante unas dos horas.

## 2. En la laptop

Todo se escribe en **Windows PowerShell** (menú Inicio, «Windows PowerShell»; no hace falta abrirlo como
administrador). Escribí los comandos como están, cambiando solo lo que va entre `< >`.

Para cerrar SIPGES **por completo** (lo pide varias veces): cerrá la ventana de SIPGES; abrí el
Administrador de tareas (Ctrl+Shift+Esc), y en «Detalles» finalizá cada `node.exe`. Después comprobá (⚠):

```powershell
try { Invoke-WebRequest -Uri http://127.0.0.1:8000/health -UseBasicParsing -TimeoutSec 2 | Out-Null; 'SIPGES sigue ABIERTO' } catch { 'SIPGES cerrado' }
```

Tiene que decir `SIPGES cerrado`.

### Paso 0 — Preparar (no toca datos)

- [ ] `node --version` dice `v24` o más.
- [ ] `Test-Path "$env:LOCALAPPDATA\SIPGES-app"` y `Test-Path "$env:LOCALAPPDATA\SIPGES-datos"` dicen
  `False` los dos. Si alguno dice `True`, alguien ya instaló algo: no sigas, la laptop queda como estaba.
- [ ] Carpeta del clon: clic derecho en el acceso directo «SIPGES» del escritorio, Propiedades, Destino.
  Lo que va antes de `\deploy\desktop\windows\start.ps1` es `<clon>`; anotalo.
- [ ] Espacio libre: `Get-PSDrive C | Format-List Free` tiene que superar cuatro veces el tamaño de
  `%LOCALAPPDATA%\SIPGES` más 2 GB (la copia de trabajo, las dos copias del primer arranque y el
  programa; es una estimación).
- [ ] Conectá el USB `F:` y descomprimí los scripts en la laptop (⚠). La carpeta firmada se queda en el USB:

  ```powershell
  New-Item -ItemType Directory "$env:LOCALAPPDATA\SIPGES-visita"
  Copy-Item F:\SIPGES-visita\sipges-scripts.zip "$env:LOCALAPPDATA\SIPGES-visita"
  Expand-Archive -LiteralPath "$env:LOCALAPPDATA\SIPGES-visita\sipges-scripts.zip" -DestinationPath "$env:LOCALAPPDATA\SIPGES-visita\sipges"
  Test-Path "$env:LOCALAPPDATA\SIPGES-visita\sipges\deploy\desktop\windows\install.ps1"
  ```

  Tiene que decir `True`. Dejá el USB conectado hasta terminar el paso 3.

### Paso 1 — Respaldo en el disco externo (T26)

Si la usuaria ya hizo hoy un respaldo comprobado, marcá este paso y anotá sus números.

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
  git status --short
  ```

  El commit tiene que ser el de T27 (el que se ensayó con `rehearse.mjs`). Si es otro, no sigas: el
  traslado no se ensayó desde ese commit. Anotá también si `git status --short` imprimió algo.
- [ ] Abrí SIPGES desde el acceso directo de siempre. Edge se abre en `http://localhost:8000` y la
  usuaria entra. Cerrá solo la ventana: el servidor sigue encendido.
- [ ] Conteos de la versión vieja. La persona que tiene la contraseña de `admin` la escribe cuando se pide
  `Contraseña:`, y un código actual del autenticador en `Código MFA (vacío si no tiene):`:

  ```powershell
  node "$env:LOCALAPPDATA\SIPGES-visita\sipges\deploy\desktop\migration\snapshot.mjs" --url http://127.0.0.1:8000 --out "$env:LOCALAPPDATA\SIPGES-visita\sipges-antes.json"
  ```

  Tenés que ver `SIPGES snapshot at …`, `Projects: N`, una línea `project N [hash]: records …, links
  …, uploads …, audit …` por proyecto, `Accounts: N` y `Written: …\sipges-antes.json`. Solo números y
  hashes cortos. Si una línea dice `(not fully checked)` o sale `Error: …`, no sigas.
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
- [ ] Instalá:

  ```powershell
  powershell -ExecutionPolicy Bypass -File "$env:LOCALAPPDATA\SIPGES-visita\sipges\deploy\desktop\windows\install.ps1" -Release F:\SIPGES-visita\release-<versión> -State "$env:LOCALAPPDATA\SIPGES-datos"
  ```

  Tenés que ver, en este orden:
  - `Trusting the update key that signed this release (SHA-256 …).` La huella **tiene que ser igual**
    a la anotada en casa. Si no lo es, regla de corte.
  - `Installed <versión>`
  - `SIPGES está instalado. Ábrelo desde el menú Inicio o el escritorio.` (todavía no lo abras)
  - `Instalación: …\SIPGES-app. …`, `Usuario administrador: admin. Contraseña: …\SIPGES-datos\admin-password`
  - `Se conservó la carpeta de datos existente …\SIPGES-datos. …` y `Respáldala tú también antes de
    abrir SIPGES.` (el respaldo del paso 1 tiene el mismo contenido).

  Si en cambio aparece `SIPGES está abierto en este equipo: …`, cerralo por completo y repetí.
  `… no es una versión firmada …`, `La carpeta de datos … tiene una base de datos pero falta su …`,
  `Esta instalación usa la carpeta de datos …` o `Falló: …`: regla de corte.
- [ ] `Get-Content "$env:LOCALAPPDATA\SIPGES-app\install.json"` muestra `stateDir` terminado en
  `SIPGES-datos`. Retirá el USB `F:` (la versión ya se copió dentro de `SIPGES-app\versions`).

### Paso 4 — Primer arranque sobre la copia (traslado T33)

Se hace en la terminal para no depender de la espera de 90 segundos del acceso directo.

- [ ] Ejecutá:

  ```powershell
  node "$env:LOCALAPPDATA\SIPGES-app\versions\<versión>\updater\update.mjs" --install "$env:LOCALAPPDATA\SIPGES-app" --first-start
  $LASTEXITCODE
  ```

  Tenés que ver `First start of <versión> done. Pre-update copy: …\SIPGES-datos.pre-update-<hora>-first-start-<versión>`
  y después `0`. Al lado de `SIPGES-datos` aparecen esa copia y `SIPGES-datos.rehearsal-<hora>-<versión>`:
  no las borres, tienen los datos y la clave.
  Si sale `Error: …` o un número distinto de `0`: regla de corte. La carpeta original no se abrió
  nunca, y `SIPGES-datos` vuelve a como estaba.
- [ ] Abrí SIPGES desde el acceso directo (ya apunta a la versión nueva). Edge se abre antes de 90 segundos.
  Si aparece un cuadro «SIPGES no arrancó en 90 segundos. Revisa …», «SIPGES se cerró al arrancar.
  Revisa …» o «SIPGES no se inició: …»: regla de corte.

### Paso 5 — Comparar

- [ ] Esperá a que el autenticador muestre un código **nuevo** (el servidor rechaza uno ya usado) y ejecutá:

  ```powershell
  node "$env:LOCALAPPDATA\SIPGES-visita\sipges\deploy\desktop\migration\compare.mjs" --before "$env:LOCALAPPDATA\SIPGES-visita\sipges-antes.json" --url http://127.0.0.1:8000
  $LASTEXITCODE
  ```

  Tenés que ver `Sign-in: ok (password and MFA code)`; por proyecto, cada módulo con
  `every field identical`, `links … identical`, `uploads … identical`, `audit … kept unchanged`;
  `Accounts: … identical`; `Isolation: … no record or upload of one project visible in another`;
  al final `RESULT: no difference` (puede seguir `(N audit entries added, listed above)`: las líneas
  `added: …` no son diferencias) y `0`. Cómo leer cada línea:
  [migration/README.md](../../deploy/desktop/migration/README.md#reading-the-comparison).
  Cualquier otro `RESULT` (`Sign-in failed`, `N differences`, `not fully checked`) o un número distinto
  de `0`: regla de corte.
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
paso 5; un inicio de sesión fallido (pasos 2, 5 o 6); un `Error: …` del primer arranque; una huella que no
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
  anotados, y en `<clon>` `git log --oneline -1` y `git status --short` dicen lo mismo que en el paso 2.

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
| «SIPGES no se inició: la versión nueva no pudo abrir los datos existentes. Sus datos no se tocaron. …» | El primer arranque falló en una copia; `SIPGES-datos` quedó como estaba. Regla de corte. |
| «SIPGES no se inició: … Restaure la copia de seguridad <copia> o contacte con soporte.» | Detención: una actualización falló y ni su vuelta atrás terminó. SIPGES no arranca sobre esos datos. |
| «SIPGES no arrancó en 90 segundos. Revisa …\launcher.log.» / «SIPGES se cerró al arrancar. Revisa …» | Versión nueva: mirá `launcher.log`. |
| «El servidor no arrancó en 90 segundos. Revisa …\api.log.» / «El servidor se cerró al arrancar. …» | Versión vieja: mirá `api.log`. |

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
   — si imprime `Recovered: rolled back to …`, abrí SIPGES.
3. Si no: renombrá la carpeta dañada (`%LOCALAPPDATA%\SIPGES-datos` → `SIPGES-datos.danada`) y copiá en su
   lugar la copia que nombra el mensaje, o tu propio respaldo.
4. `node "$env:LOCALAPPDATA\SIPGES-app\versions\<versión>\updater\update.mjs" --install "$env:LOCALAPPDATA\SIPGES-app" --recover --accept-restored-state`
   — imprime `Accepted the restored state folder; current version …`. Se niega mientras la carpeta falta o
   está vacía.
5. Abrí SIPGES.

Códigos de salida de `update.mjs` (`$LASTEXITCODE`): 0 hecho, 1 rechazado, 2 falló y volvió atrás,
3 vuelta atrás incompleta. Detalle: [Si una actualización se detiene a medias](../../deploy/desktop/README.es.md#si-una-actualización-se-detiene-a-medias).

**Qué llevarse para revisar en casa**

- [ ] Solo los registros, copiados al USB `F:` conectado de nuevo (los que no existan dan un error que
  podés ignorar):

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
  `SIPGES-visita` y las copias al lado de `SIPGES-datos`. Ninguna se borra sola; pasado ese plazo se decide
  qué guardar. Todas contienen los datos y la clave: se tratan como un respaldo.
- **Cómo llegan las actualizaciones**: se construye y firma en Windows una versión mayor con **la misma
  clave** (los comandos de la sección 1 con otro `<versión>` y notas en `--notes`) y su carpeta se copia
  dentro de `%LOCALAPPDATA%\SIPGES-app\releases`. En el siguiente arranque la usuaria (administradora) ve
  «Nueva versión de SIPGES». Nada se descarga ni se instala sin su clic en «Actualizar». Una carpeta dañada,
  incompleta o firmada con otra clave no se ofrece. Cada actualización deja
  `SIPGES-datos.pre-update-<hora>-<de>-to-<a>` al lado de la carpeta. Cómo viaja la carpeta firmada hasta la
  laptop (USB u otro medio) está por decidir; no tiene secretos.
- **Respaldo**: el del paso 8, siempre antes de pulsar «Actualizar» y con la frecuencia que acuerden.
  Nunca en una carpeta compartida o sincronizada con la nube. Para restaurar:
  [Respaldar y restaurar](../../deploy/desktop/README.es.md#respaldar-y-restaurar), pasos 5 a 8 (la carpeta
  de datos es `%LOCALAPPDATA%\SIPGES-datos`).
