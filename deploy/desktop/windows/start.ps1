# Opens SIPGES as a desktop app: reuses the local server when it answers, otherwise starts it
# hidden from this checkout, then opens Microsoft Edge in app mode. The shortcuts that
# install.ps1 creates run this script. Read deploy\desktop\README.md first.
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms

$Repo = (Resolve-Path (Join-Path $PSScriptRoot '..\..\..')).Path
$State = Join-Path $env:LOCALAPPDATA 'SIPGES'
$Url = 'http://localhost:8000'
# The server binds 127.0.0.1; "localhost" may resolve to ::1 first, where nothing listens.
$Probe = 'http://127.0.0.1:8000/health'
$WaitSeconds = 90
$Log = Join-Path $State 'api.log'

function Show-Failure([string]$Message) {
    [System.Windows.Forms.MessageBox]::Show($Message, 'SIPGES', 'OK', 'Error') | Out-Null
    exit 1
}

function Test-Server {
    try {
        Invoke-WebRequest -Uri $Probe -UseBasicParsing -TimeoutSec 2 | Out-Null
        return $true
    } catch {
        return $false
    }
}

function Read-Secret([string]$Name) {
    $path = Join-Path $State $Name
    $value = $null
    if (Test-Path -LiteralPath $path) { $value = Get-Content -LiteralPath $path -Raw }
    if ([string]::IsNullOrWhiteSpace($value)) {
        Show-Failure "Falta o está vacío $path. Ejecuta de nuevo deploy\desktop\windows\install.ps1."
    }
    $value.Trim()
}

# Appends to api.log (a plain redirect through cmd keeps earlier runs) and hides the window.
function Start-Server {
    $env:SIPGES_DATA_KEY = Read-Secret 'data-key'
    $env:SIPGES_ADMIN_PASSWORD = Read-Secret 'admin-password'
    $env:SIPGES_COOKIE_SECURE = '0'
    $env:SIPGES_HOST = '127.0.0.1'
    $env:SIPGES_PGLITE_DIR = Join-Path $State 'pglite'
    $env:SIPGES_UPLOAD_DIR = Join-Path $State 'uploads'
    $env:SIPGES_WEB_DIR = Join-Path $Repo 'apps\web\dist'
    try {
        $command = '"{0}" apps\api\src\main.ts >> "{1}" 2>&1' -f (Get-Command node).Source, $Log
        Start-Process -FilePath $env:ComSpec -ArgumentList "/d /c `"$command`"" `
            -WorkingDirectory $Repo -WindowStyle Hidden -PassThru
    } finally {
        # Node has its own copy; nothing started later (Edge) should inherit the secrets.
        Remove-Item Env:SIPGES_DATA_KEY -ErrorAction SilentlyContinue
        Remove-Item Env:SIPGES_ADMIN_PASSWORD -ErrorAction SilentlyContinue
    }
}

try {
    if (-not (Test-Server)) {
        # A second click while the first one is still booting only waits for the same server.
        $created = $false
        $booting = New-Object System.Threading.Mutex($true, 'Local\SIPGES-start', [ref]$created)
        $server = $null
        if ($created) { $server = Start-Server }
        $deadline = (Get-Date).AddSeconds($WaitSeconds)
        while (-not (Test-Server)) {
            # Release before the message box so later clicks are not held by an open dialog.
            if ($server -and $server.HasExited) {
                if ($created) { $booting.ReleaseMutex() }
                Show-Failure "El servidor se cerró al arrancar. Revisa $Log."
            }
            if ((Get-Date) -gt $deadline) {
                if ($created) { $booting.ReleaseMutex() }
                Show-Failure "El servidor no arrancó en $WaitSeconds segundos. Revisa $Log."
            }
            Start-Sleep -Seconds 1
        }
    }
    Start-Process -FilePath 'msedge.exe' -ArgumentList "--app=$Url"
} catch {
    Show-Failure "SIPGES no pudo abrirse: $($_.Exception.Message)"
}
