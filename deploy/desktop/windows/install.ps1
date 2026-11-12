# One-time setup of the SIPGES desktop app on Windows. Run it from the cloned repository:
#   powershell -ExecutionPolicy Bypass -File deploy\desktop\windows\install.ps1
# Safe to rerun after `git pull`; an existing data key and admin password are never overwritten.
# Read deploy\desktop\README.md first.
$ErrorActionPreference = 'Stop'

$Repo = (Resolve-Path (Join-Path $PSScriptRoot '..\..\..')).Path
$State = Join-Path $env:LOCALAPPDATA 'SIPGES'
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

$node = Get-Command node -ErrorAction SilentlyContinue
$major = 0
if ($node) { $major = [int](& node -p "process.versions.node.split('.')[0]") }
if ($major -lt 24) {
    Stop-Install 'Node.js 24 o posterior es necesario: instálalo con `winget install OpenJS.NodeJS.LTS` y vuelve a ejecutar este script.'
}

Install-Pnpm
Set-Location $Repo
Invoke-Checked 'pnpm install --frozen-lockfile' { pnpm install --frozen-lockfile }
Invoke-Checked 'pnpm --filter @sipges/web build' { pnpm --filter '@sipges/web' build }

if (-not (Test-Path -LiteralPath $State)) { New-Item -ItemType Directory -Path $State | Out-Null }
Protect-Path $State '(OI)(CI)F'
foreach ($name in 'pglite', 'uploads') {
    New-Item -ItemType Directory -Force -Path (Join-Path $State $name) | Out-Null
}
Save-Secret (Join-Path $State 'data-key') (New-RandomBase64 32)
$password = (New-RandomBase64 24).Replace('+', 'A').Replace('/', 'B').Replace('=', '')
Save-Secret (Join-Path $State 'admin-password') $password

$start = Join-Path $PSScriptRoot 'start.ps1'
$icon = Join-Path $Repo 'deploy\desktop\sipges.ico'
$shell = New-Object -ComObject WScript.Shell
foreach ($folder in [Environment]::GetFolderPath('Programs'), [Environment]::GetFolderPath('Desktop')) {
    $link = $shell.CreateShortcut((Join-Path $folder 'SIPGES.lnk'))
    $link.TargetPath = "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe"
    $link.Arguments = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$start`""
    $link.WorkingDirectory = $Repo
    $link.IconLocation = $icon
    $link.Description = 'SIPGES en este equipo'
    $link.Save()
}

Write-Host ''
Write-Host 'SIPGES está instalado. Ábrelo desde el menú Inicio o el escritorio.'
Write-Host "Usuario administrador: admin. Contraseña: $State\admin-password"
Write-Host "Respalda la carpeta completa $State (contiene tus datos y su clave)."
