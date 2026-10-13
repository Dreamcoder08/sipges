<#
  Inicia MASCLI para publicarlo mediante Cloudflare Tunnel + Cloudflare Access.
  Uso:  powershell -ExecutionPolicy Bypass -File deploy\cloudflare\iniciar_mascli_tunel.ps1 -Hostname mascli.ejemplo.org
  Requisitos previos (una sola vez): ver DESPLIEGUE_CLOUDFLARE.md.
#>
param(
  [Parameter(Mandatory = $true)][string]$Hostname,
  [string]$TunnelName = 'mascli',
  [string]$DataDir = (Join-Path $env:LOCALAPPDATA 'MASCLI\data'),
  [int]$Port = 8000
)
$ErrorActionPreference = 'Stop'
$Root = Resolve-Path (Join-Path $PSScriptRoot '..\..')
Set-Location $Root

# Datos fuera de la carpeta del código: sobreviven a actualizaciones y reinicios.
New-Item -ItemType Directory -Force -Path $DataDir | Out-Null
$env:MASCLI_DATA_DIR = $DataDir
$env:MASCLI_ALLOWED_HOSTS = "$Hostname,localhost,127.0.0.1"
$env:MASCLI_COOKIE_SECURE = '1'
$env:MASCLI_REQUIRE_MFA = '1'

# La contraseña inicial solo se pide en el primer arranque y nunca se guarda en disco.
if (-not (Test-Path (Join-Path $DataDir 'auth_global.db')) -and -not $env:MASCLI_ADMIN_PASSWORD) {
  $secure = Read-Host 'Contraseña inicial del administrador (mínimo 12 caracteres)' -AsSecureString
  $env:MASCLI_ADMIN_PASSWORD = [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure))
}

if (-not (Test-Path '.venv\Scripts\python.exe')) {
  py -3.12 -m venv .venv
  .\.venv\Scripts\python.exe -m pip install -r requirements.txt
}

Write-Host "Datos en: $DataDir"
Write-Host "Publicando https://$Hostname (protegido por Cloudflare Access + login MASCLI con MFA)"
$cloudflared = Start-Process cloudflared -ArgumentList @('tunnel', 'run', $TunnelName) -PassThru -NoNewWindow
try {
  .\.venv\Scripts\python.exe -m uvicorn app:app --host 127.0.0.1 --port $Port --proxy-headers --forwarded-allow-ips 127.0.0.1
} finally {
  if ($cloudflared -and -not $cloudflared.HasExited) { Stop-Process -Id $cloudflared.Id }
}
