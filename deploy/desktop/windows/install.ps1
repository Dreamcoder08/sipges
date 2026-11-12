# One-time setup of the SIPGES desktop app on Windows. Run it from the cloned repository:
#   powershell -ExecutionPolicy Bypass -File deploy\desktop\windows\install.ps1
#     Clone mode: builds this checkout and points the shortcuts at it. Safe to rerun after
#     `git pull`; an existing data key and admin password are never overwritten.
#   powershell -ExecutionPolicy Bypass -File deploy\desktop\windows\install.ps1 -Release <folder>
#     Managed mode: installs a signed release into %LOCALAPPDATA%\SIPGES-app, keeps the state
#     folder where it is, and points the shortcuts at that install, so updates arrive through the
#     update notice. A rerun keeps the installed version and only refreshes the shortcuts.
#   ... install.ps1 -Release <folder> -State <folder>
#     Managed mode on another state folder, such as a copy of %LOCALAPPDATA%\SIPGES made for
#     the data move (deploy\desktop\migration\README.md); the original stays as it was.
# Read deploy\desktop\README.md first.
param([string]$Release, [string]$State)
$ErrorActionPreference = 'Stop'

$Repo = (Resolve-Path (Join-Path $PSScriptRoot '..\..\..')).Path
if ($State -and -not $Release) {
    Write-Host '-State solo sirve con -Release (instalación gestionada).' -ForegroundColor Red
    exit 1
}
if (-not $State) { $State = Join-Path $env:LOCALAPPDATA 'SIPGES' }
$State = [System.IO.Path]::GetFullPath($State)
$AppRoot = Join-Path $env:LOCALAPPDATA 'SIPGES-app'
$Updater = Join-Path $Repo 'deploy\desktop\updater'
$Probe = 'http://127.0.0.1:8000/health'
$Identity = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name

function Stop-Install([string]$Message) {
    Write-Host $Message -ForegroundColor Red
    exit 1
}

function Invoke-Checked([string]$Description, [scriptblock]$Command) {
    & $Command
    if ($LASTEXITCODE -ne 0) { Stop-Install "Falló: $Description (código $LASTEXITCODE)." }
}

function Test-Pnpm12 {
    if (-not (Get-Command pnpm -ErrorAction SilentlyContinue)) { return $false }
    $version = (& pnpm --version) -join ''
    return ($LASTEXITCODE -eq 0 -and $version -match '^12\.')
}

# Node.js 25 and later no longer ship the pnpm shim, so pnpm comes from npm.
function Install-Pnpm {
    if (Test-Pnpm12) { return }
    $failure = 'No se pudo instalar pnpm: ejecuta `npm install -g pnpm@12.11.2` en una terminal nueva y vuelve a ejecutar este script.'
    try { & npm install -g pnpm@12.11.2 } catch { Stop-Install $failure }
    if ($LASTEXITCODE -ne 0) { Stop-Install $failure }
    # This session may predate the npm global folder; add it so pnpm is found right away.
    $prefix = ((& npm prefix -g) -join '').Trim()
    if ($prefix -and ($env:Path -notlike "*$prefix*")) { $env:Path = "$prefix;$env:Path" }
    if (-not (Test-Pnpm12)) { Stop-Install $failure }
}

function New-RandomBase64([int]$ByteCount) {
    $buffer = New-Object byte[] $ByteCount
    $generator = [System.Security.Cryptography.RandomNumberGenerator]::Create()
    try { $generator.GetBytes($buffer) } finally { $generator.Dispose() }
    [Convert]::ToBase64String($buffer)
}

function Protect-Path([string]$Path, [string]$Grant) {
    & icacls.exe $Path /inheritance:r /grant:r "${Identity}:$Grant" | Out-Null
    if ($LASTEXITCODE -ne 0) { Stop-Install "No se pudo restringir el acceso a $Path." }
}

# The secret is written once. A missing or blank file is created empty, restricted to the
# current user, and only then filled; an existing one keeps its content and has its access
# restricted again.
function Save-Secret([string]$Path, [string]$Value) {
    $current = $null
    if (Test-Path -LiteralPath $Path) { $current = Get-Content -LiteralPath $Path -Raw }
    if (-not [string]::IsNullOrWhiteSpace($current)) { Protect-Path $Path '(R,W)'; return }
    if (-not (Test-Path -LiteralPath $Path)) { New-Item -ItemType File -Path $Path | Out-Null }
    Protect-Path $Path '(R,W)'
    [System.IO.File]::WriteAllText($Path, $Value)
}

function Test-Server {
    try {
        Invoke-WebRequest -Uri $Probe -UseBasicParsing -TimeoutSec 2 | Out-Null
        return $true
    } catch {
        return $false
    }
}

# The state folder and each missing secret, never overwriting one.
function Initialize-State {
    if (-not (Test-Path -LiteralPath $State)) { New-Item -ItemType Directory -Path $State | Out-Null }
    Protect-Path $State '(OI)(CI)F'
    foreach ($name in 'pglite', 'uploads') {
        New-Item -ItemType Directory -Force -Path (Join-Path $State $name) | Out-Null
    }
    Save-Secret (Join-Path $State 'data-key') (New-RandomBase64 32)
    $password = (New-RandomBase64 24).Replace('+', 'A').Replace('/', 'B').Replace('=', '')
    Save-Secret (Join-Path $State 'admin-password') $password
}

# An existing database keeps its own key: a new one would leave its sealed values unreadable.
function Test-DatabaseWithoutKey {
    $pglite = Join-Path $State 'pglite'
    if (-not (Test-Path -LiteralPath $pglite -PathType Container)) { return $false }
    if (-not (Get-ChildItem -LiteralPath $pglite -Force | Select-Object -First 1)) { return $false }
    $key = Join-Path $State 'data-key'
    $value = $null
    if (Test-Path -LiteralPath $key) { $value = Get-Content -LiteralPath $key -Raw }
    return [string]::IsNullOrWhiteSpace($value)
}

function New-Shortcuts([string]$Start, [string]$WorkingDirectory, [string]$Icon) {
    $shell = New-Object -ComObject WScript.Shell
    foreach ($folder in [Environment]::GetFolderPath('Programs'), [Environment]::GetFolderPath('Desktop')) {
        $link = $shell.CreateShortcut((Join-Path $folder 'SIPGES.lnk'))
        $link.TargetPath = "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe"
        $link.Arguments = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$Start`""
        $link.WorkingDirectory = $WorkingDirectory
        $link.IconLocation = $Icon
        $link.Description = 'SIPGES en este equipo'
        $link.Save()
    }
}

# Managed mode. Nothing is written before every check passed; the state folder is never moved,
# overwritten or deleted: only missing secrets are created, as in clone mode.
function Install-Managed {
    $source = $null
    if (Test-Path -LiteralPath $Release -PathType Container) { $source = (Resolve-Path -LiteralPath $Release).Path }
    $signed = $source -and (Test-Path -LiteralPath (Join-Path $source 'release.json')) -and
        (Test-Path -LiteralPath (Join-Path $source 'release.sig')) -and
        (Test-Path -LiteralPath (Join-Path $source 'package') -PathType Container)
    if (-not $signed) {
        Stop-Install "$Release no es una versión firmada (hacen falta release.json, release.sig y la carpeta package)."
    }
    if (Test-Server) {
        Stop-Install 'SIPGES está abierto en este equipo: ciérralo (termina el proceso node o reinicia el equipo) y vuelve a ejecutar este script.'
    }
    if (Test-DatabaseWithoutKey) {
        Stop-Install "La carpeta de datos $State tiene una base de datos pero falta su data-key o está vacía: restáurala desde tu respaldo de esa carpeta y vuelve a ejecutar este script; no se cambió nada."
    }
    $hadState = (Test-Path -LiteralPath $State) -and -not (Test-Path -LiteralPath (Join-Path $AppRoot 'first-start.json'))
    if (-not (Test-Path -LiteralPath $AppRoot)) { New-Item -ItemType Directory -Path $AppRoot | Out-Null }
    Protect-Path $AppRoot '(OI)(CI)F'
    if (Test-Path -LiteralPath (Join-Path $AppRoot 'current.json')) {
        Write-Host 'SIPGES ya está instalado: las actualizaciones llegan por el aviso. Solo se renuevan los accesos directos.'
    } else {
        Invoke-Checked 'instalar la versión firmada' {
            & node (Join-Path $Updater 'update.mjs') --install $AppRoot --release $source --state $State --trust-release-key
        }
    }
    Initialize-State
    New-Item -ItemType Directory -Force -Path (Join-Path $AppRoot 'releases') | Out-Null
    Copy-Item -LiteralPath (Join-Path $Updater 'run-current.mjs') -Destination (Join-Path $AppRoot 'run-current.mjs') -Force
    Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'start-managed.ps1') -Destination (Join-Path $AppRoot 'start.ps1') -Force
    Copy-Item -LiteralPath (Join-Path $Repo 'deploy\desktop\sipges.ico') -Destination (Join-Path $AppRoot 'sipges.ico') -Force
    New-Shortcuts (Join-Path $AppRoot 'start.ps1') $AppRoot (Join-Path $AppRoot 'sipges.ico')

    Write-Host ''
    Write-Host 'SIPGES está instalado. Ábrelo desde el menú Inicio o el escritorio.'
    Write-Host "Instalación: $AppRoot. Copia las versiones firmadas nuevas en $AppRoot\releases para que se ofrezcan."
    Write-Host "Usuario administrador: admin. Contraseña: $State\admin-password"
    if ($hadState) {
        Write-Host "Se conservó la carpeta de datos existente $State. Su primer arranque la copia al lado ($State.pre-update-<hora>-first-start-<versión>), migra una segunda copia y solo después la carpeta."
        Write-Host 'Respáldala tú también antes de abrir SIPGES.'
    }
    Write-Host "Respalda la carpeta completa $State (contiene tus datos y su clave)."
}

$node = Get-Command node -ErrorAction SilentlyContinue
$major = 0
if ($node) { $major = [int](& node -p "process.versions.node.split('.')[0]") }
if ($major -lt 24) {
    Stop-Install 'Node.js 24 o posterior es necesario: instálalo con `winget install OpenJS.NodeJS.LTS` y vuelve a ejecutar este script.'
}

if ($Release) {
    Install-Managed
    exit 0
}

Install-Pnpm
Set-Location $Repo
Invoke-Checked 'pnpm install --frozen-lockfile' { pnpm install --frozen-lockfile }
Invoke-Checked 'pnpm --filter @sipges/web build' { pnpm --filter '@sipges/web' build }

Initialize-State
New-Shortcuts (Join-Path $PSScriptRoot 'start.ps1') $Repo (Join-Path $Repo 'deploy\desktop\sipges.ico')

Write-Host ''
Write-Host 'SIPGES está instalado. Ábrelo desde el menú Inicio o el escritorio.'
Write-Host "Usuario administrador: admin. Contraseña: $State\admin-password"
Write-Host "Respalda la carpeta completa $State (contiene tus datos y su clave)."
